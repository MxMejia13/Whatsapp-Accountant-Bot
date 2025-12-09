require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const twilio = require('twilio');
const OpenAI = require('openai');
const { connectMongoDB, getOrCreateUser, saveMediaFile, User } = require('./database/mongodb');
const { processMedia, processEmailAttachment } = require('./services/MediaProcessor');
const { processMessage: processAgentMessage, sendWhatsAppMessage } = require('./services/AgentService');
const { initScheduler } = require('./services/SchedulerService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Store conversation context (in production, use MongoDB)
const conversationHistory = new Map();

// ============================================================================
// SYSTEM DIAGNOSTICS
// ============================================================================

/**
 * Run system diagnostics to verify all services are properly configured
 * Runs after MongoDB connection, before server starts
 */
async function runDiagnostics() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🔍 SYSTEM DIAGNOSTICS - V3.0 Health Check');
  console.log('═══════════════════════════════════════════════════════════\n');

  const checks = [];

  // 1. MongoDB
  const mongoStatus = mongoose.connection.readyState === 1;
  checks.push({
    service: 'MongoDB',
    status: mongoStatus,
    detail: mongoStatus ? 'Connected' : 'Disconnected'
  });

  // 2. OpenAI
  const openaiStatus = !!process.env.OPENAI_API_KEY;
  checks.push({
    service: 'OpenAI API',
    status: openaiStatus,
    detail: openaiStatus ? 'API Key configured' : 'Missing OPENAI_API_KEY'
  });

  // 3. Twilio
  const twilioStatus = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;
  checks.push({
    service: 'Twilio (WhatsApp)',
    status: twilioStatus,
    detail: twilioStatus ? 'Credentials configured' : 'Missing Twilio credentials'
  });

  // 4. R2 Storage (Cloudflare)
  const r2Status = !!process.env.CLOUD_STORAGE_ACCESS_KEY && !!process.env.CLOUD_STORAGE_ENDPOINT;
  checks.push({
    service: 'R2 Storage',
    status: r2Status,
    detail: r2Status ? 'Endpoint configured' : 'Missing R2 credentials'
  });

  // 5. Resend/SMTP
  const smtpStatus = !!process.env.SMTP_PASS && !!process.env.SMTP_HOST;
  checks.push({
    service: 'Resend/SMTP',
    status: smtpStatus,
    detail: smtpStatus ? 'Email service configured' : 'Missing SMTP credentials'
  });

  // 6. Server Port
  const portStatus = !!process.env.PORT || !!PORT;
  checks.push({
    service: 'Server Port',
    status: portStatus,
    detail: `Port ${process.env.PORT || PORT}`
  });

  // Display results
  checks.forEach(check => {
    const icon = check.status ? '✅' : '❌';
    const status = check.status ? 'OK' : 'FAIL';
    console.log(`${icon} ${check.service.padEnd(25)} [${status}] ${check.detail}`);
  });

  console.log('\n═══════════════════════════════════════════════════════════');

  // Check for critical failures
  const criticalServices = ['MongoDB', 'OpenAI API', 'Twilio (WhatsApp)'];
  const criticalFailures = checks.filter(c =>
    criticalServices.includes(c.service) && !c.status
  );

  if (criticalFailures.length > 0) {
    console.error('❌ CRITICAL: Some essential services are not configured!');
    console.error('Please check your environment variables and try again.\n');
    process.exit(1);
  }

  // Warnings for optional services
  const optionalFailures = checks.filter(c =>
    !criticalServices.includes(c.service) && !c.status
  );

  if (optionalFailures.length > 0) {
    console.warn('⚠️  WARNING: Some optional services are not configured:');
    optionalFailures.forEach(f => console.warn(`   - ${f.service}`));
    console.warn('   The bot will run with limited functionality.\n');
  }

  console.log('✅ All critical systems operational!');
  console.log('🚀 Server is ready to start...\n');
}

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

/**
 * WhatsApp Webhook - Incoming messages from Twilio
 */
app.post('/webhook', async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const from = req.body.From;
    const messageId = req.body.MessageSid;
    const numMedia = parseInt(req.body.NumMedia) || 0;

    console.log(`📱 Received message from ${from}: ${incomingMsg}`);

    // Ignore messages from the bot itself
    if (from === process.env.TWILIO_WHATSAPP_NUMBER) {
      console.log('⏭️  Ignoring message from bot itself');
      res.status(200).send('OK');
      return;
    }

    // Extract phone number (remove whatsapp: prefix)
    const phoneNumber = from.replace('whatsapp:', '');

    // Get or create user in MongoDB
    const user = await getOrCreateUser(phoneNumber);

    // Process media attachments if present
    if (numMedia > 0) {
      console.log(`📎 Processing ${numMedia} media attachment(s)...`);

      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mimeType = req.body[`MediaContentType${i}`];

        try {
          // Process media with AI
          const processedMedia = await processMedia({
            mediaUrl,
            mimeType,
            ownerPhoneNumber: phoneNumber,
            ownerTitle: user.title || user.name,
            userMessage: incomingMsg,
            isForwarded: false
          });

          // Save to MongoDB
          await saveMediaFile({
            ownerPhoneNumber: phoneNumber,
            ownerTitle: user.title || user.name,
            url: processedMedia.url,
            s3Key: processedMedia.s3Key,
            filename: processedMedia.filename,
            description: processedMedia.description,
            keywords: processedMedia.keywords,
            detectedText: processedMedia.detectedText,
            documentType: processedMedia.documentType,
            confidence: processedMedia.confidence,
            originalName: processedMedia.originalName,
            mimeType: processedMedia.mimeType,
            fileSize: processedMedia.fileSize,
            isForwarded: false,
            twilioMediaUrl: mediaUrl
          });

          console.log(`✅ Saved media: ${processedMedia.filename}`);

          // Send confirmation to user
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: from,
            body: `✅ Guardado: "${processedMedia.filename}"\n\n📝 ${processedMedia.description}`
          });

        } catch (error) {
          console.error(`❌ Error processing media ${i}:`, error);
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: from,
            body: `❌ Error al procesar el archivo. Por favor, intenta de nuevo.`
          });
        }
      }

      res.status(200).send('OK');
      return;
    }

    // Handle text messages with AI using AgentService
    if (incomingMsg && incomingMsg.trim()) {
      // Get or initialize conversation history
      if (!conversationHistory.has(from)) {
        conversationHistory.set(from, []);
      }
      const history = conversationHistory.get(from);

      try {
        // Process message through AgentService (includes user lookup and context injection)
        const agentResponse = await processAgentMessage({
          userMessage: incomingMsg,
          conversationHistory: history,
          phoneNumber: from,
          hasMediaAttached: false,
          mediaType: null,
          mediaAnalysis: null
        });

        if (!agentResponse.success) {
          console.error('❌ Agent processing failed:', agentResponse.error);
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: from,
            body: 'Lo siento, tuve un problema procesando tu mensaje. Por favor, intenta de nuevo.'
          });
          res.status(500).send('AI service error');
          return;
        }

        // Add user message to history
        history.push({
          role: 'user',
          content: incomingMsg
        });

        // Add AI response to history
        history.push({
          role: 'assistant',
          content: agentResponse.response
        });

        // Keep only last 20 messages
        if (history.length > 20) {
          history.splice(0, history.length - 20);
        }

        // Send response
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: from,
          body: agentResponse.response
        });

        console.log(`✅ Response sent to ${from}`);

      } catch (error) {
        console.error('❌ Error in agent processing:', error);
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: from,
          body: 'Lo siento, tuve un problema procesando tu mensaje. Por favor, intenta de nuevo.'
        });
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error processing WhatsApp message:', error);
    res.status(500).send('Error processing message');
  }
});

/**
 * Email Webhook - Incoming emails from Resend
 * Receives emails at bot@mejiafamily.app, processes attachments, saves to vault
 */
app.post('/webhooks/email', async (req, res) => {
  try {
    const { from, subject, html, text, attachments } = req.body;

    console.log(`📧 Received email from: ${from}`);
    console.log(`   Subject: ${subject}`);

    // Find user by email address
    const user = await User.findOne({ email: from?.toLowerCase() });

    if (!user) {
      console.log(`⚠️  Unknown sender: ${from} - Ignoring (anti-spam)`);
      res.status(200).send('OK');
      return;
    }

    console.log(`✅ Email from registered user: ${user.title || user.name} (${user.phoneNumber})`);

    // Process attachments
    if (attachments && attachments.length > 0) {
      const savedFiles = [];

      for (const attachment of attachments) {
        const { filename, content, contentType } = attachment;

        try {
          // Decode base64 attachment
          const attachmentBuffer = Buffer.from(content, 'base64');

          console.log(`📎 Processing attachment: ${filename} (${contentType})`);

          // Process with MediaProcessor
          const processedMedia = await processEmailAttachment({
            attachmentBuffer,
            filename,
            mimeType: contentType,
            ownerPhoneNumber: user.phoneNumber,
            ownerTitle: user.title || user.name,
            emailSubject: subject
          });

          // Save to MongoDB
          const savedFile = await saveMediaFile({
            ownerPhoneNumber: user.phoneNumber,
            ownerTitle: user.title || user.name,
            url: processedMedia.url,
            s3Key: processedMedia.s3Key,
            filename: processedMedia.filename,
            description: processedMedia.description,
            keywords: processedMedia.keywords,
            detectedText: processedMedia.detectedText,
            documentType: processedMedia.documentType,
            confidence: processedMedia.confidence,
            originalName: filename,
            mimeType: contentType,
            fileSize: processedMedia.fileSize,
            isForwarded: false
          });

          savedFiles.push(savedFile);
          console.log(`✅ Saved email attachment: ${savedFile.filename}`);

        } catch (error) {
          console.error(`❌ Error processing attachment ${filename}:`, error);
        }
      }

      // Send WhatsApp notification if files were saved
      if (savedFiles.length > 0) {
        const userWhatsApp = `whatsapp:${user.phoneNumber}`;
        const fileList = savedFiles.map(f => `• ${f.filename}`).join('\n');
        const message = `📥 Recibí tu correo de ${from}\n\n📌 Asunto: ${subject}\n\n✅ Guardé ${savedFiles.length} archivo(s) en tu bóveda:\n${fileList}\n\nYa puedes buscarlos en WhatsApp. 🔍`;

        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: userWhatsApp,
            body: message
          });
          console.log(`✅ WhatsApp notification sent to ${user.phoneNumber}`);
        } catch (error) {
          console.error(`❌ Error sending WhatsApp notification:`, error);
        }
      }
    } else {
      console.log('   No attachments to process');
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Email webhook error:', error);
    res.status(500).send('Error');
  }
});

// ============================================================================
// HEALTH CHECK ENDPOINTS
// ============================================================================

app.get('/', (req, res) => {
  res.send('WhatsApp Accountant Bot V3.0 is running! 🚀');
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    activeConversations: conversationHistory.size,
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ============================================================================
// STARTUP SEQUENCE
// ============================================================================

async function startServer() {
  try {
    console.log('\n🚀 Starting WhatsApp Accountant Bot V3.0...\n');

    // 1. Connect to MongoDB
    console.log('📦 Connecting to MongoDB...');
    await connectMongoDB();

    // 2. Run system diagnostics
    await runDiagnostics();

    // 3. Initialize Scheduler (Agenda + MongoDB)
    console.log('⏰ Initializing reminder scheduler...');
    try {
      await initScheduler(process.env.MONGODB_URI, twilioClient);
    } catch (error) {
      console.warn('⚠️  Scheduler initialization failed:', error.message);
      console.warn('   Reminders will not work, but other features will continue.');
    }

    // 4. Start Express server
    app.listen(PORT, () => {
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`✅ Server is running on port ${PORT}`);
      console.log(`📱 WhatsApp Webhook: http://localhost:${PORT}/webhook`);
      console.log(`📧 Email Webhook: http://localhost:${PORT}/webhooks/email`);
      console.log(`💚 Health Check: http://localhost:${PORT}/status`);
      console.log('═══════════════════════════════════════════════════════════\n');
    });

  } catch (error) {
    console.error('\n❌ FATAL ERROR during startup:', error);
    console.error('Server cannot start. Please fix the errors above and try again.\n');
    process.exit(1);
  }
}

// Start the server
startServer();
