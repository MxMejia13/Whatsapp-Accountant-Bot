require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const twilio = require('twilio');
const OpenAI = require('openai');
const { connectMongoDB, getOrCreateUser, saveMediaFile, User, saveMessageToHistory, getConversationHistory } = require('./database/mongodb');
const { processMedia, processEmailAttachment } = require('./services/MediaProcessor');
const { processMessage: processAgentMessage, sendWhatsAppMessage } = require('./services/AgentService');
const { initScheduler } = require('./services/SchedulerService');
const { addMessage, getRecentMedia, setPendingExtraction, getPendingExtraction } = require('./utils/conversationContext');

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

  // 5. SendGrid Email
  const sendgridStatus = !!process.env.SENDGRID_API_KEY && !!process.env.SENDGRID_FROM;
  checks.push({
    service: 'SendGrid Email',
    status: sendgridStatus,
    detail: sendgridStatus ? 'Email service configured' : 'Missing SendGrid API key'
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

    // CONTEXTUAL AWARENESS: Check if this is a reply to a previous message
    const originalRepliedMessageSid = req.body.OriginalRepliedMessageSid || null;

    console.log(`📱 Received message from ${from}: ${incomingMsg}`);
    if (originalRepliedMessageSid) {
      console.log(`   🔗 Reply to message: ${originalRepliedMessageSid}`);
    }

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

    // CONTEXTUAL LOOKUP: If user is replying to a previous message, retrieve context
    let replyContext = null;
    if (originalRepliedMessageSid) {
      try {
        const { MediaFile } = require('./database/mongodb');
        const contextFile = await MediaFile.findOne({ twilioMessageSid: originalRepliedMessageSid });

        if (contextFile) {
          replyContext = {
            type: 'file',
            fileId: contextFile._id,
            filename: contextFile.filename,
            description: contextFile.description,
            documentType: contextFile.documentType,
            s3Key: contextFile.s3Key,
            detectedText: contextFile.detectedText,
            documentDate: contextFile.documentDate,
            vendorName: contextFile.vendorName,
            amount: contextFile.amount,
            createdAt: contextFile.createdAt
          };
          console.log(`   ✅ Found reply context: ${contextFile.filename} (${contextFile.documentType})`);
        } else {
          console.log(`   ⚠️  Reply context not found for message SID: ${originalRepliedMessageSid}`);
        }
      } catch (error) {
        console.error(`   ❌ Error retrieving reply context:`, error);
      }
    }

    // Process media attachments if present
    if (numMedia > 0) {
      console.log(`📎 Processing ${numMedia} media attachment(s)...`);

      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mimeType = req.body[`MediaContentType${i}`];

        try {
          // Process media with AI (includes R2 upload and MongoDB save)
          const result = await processMedia({
            mediaUrl,
            mimeType,
            ownerPhoneNumber: phoneNumber,
            ownerTitle: user.title || user.name,
            userMessage: incomingMsg,
            isForwarded: false,
            twilioMessageSid: messageId // Link media to this message for future reply context
          });

          // Handle result based on action
          if (result.action === 'SAVED') {
            // File was successfully saved by processMedia
            console.log(`✅ Media processed and saved: ${result.savedFile.filename}`);

            // Add to conversation context for follow-up messages
            addMessage(phoneNumber, {
              hasMedia: true,
              mediaType: mimeType,
              mediaAnalysis: result.analysis,
              s3Key: result.savedFile.s3Key || result.analysis.s3Key,
              filename: result.savedFile.filename,
              savedToDb: true
            });

            // Send confirmation to user
            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_NUMBER,
              to: from,
              body: result.message
            });

          } else if (result.action === 'ANALYZED') {
            // User asked a question - media analyzed but NOT saved
            console.log(`🔍 Media analyzed (question mode) - storing in context`);

            // Add to conversation context for follow-up messages
            addMessage(phoneNumber, {
              hasMedia: true,
              mediaType: mimeType,
              mediaAnalysis: result.analysis,
              s3Key: result.analysis.s3Key || null,
              filename: result.analysis.filename
            });

            // Route to agent with media context
            try {
              const history = await getConversationHistory(from, 10);

              const agentResponse = await processAgentMessage({
                userMessage: incomingMsg,
                conversationHistory: history,
                phoneNumber: from,
                hasMediaAttached: true,
                mediaType: mimeType,
                mediaAnalysis: result.analysis,
                replyContext: null
              });

              if (agentResponse.success) {
                await saveMessageToHistory(from, 'user', incomingMsg);
                await saveMessageToHistory(from, 'assistant', agentResponse.response);

                await twilioClient.messages.create({
                  from: process.env.TWILIO_WHATSAPP_NUMBER,
                  to: from,
                  body: agentResponse.response
                });
              }
            } catch (agentError) {
              console.error('❌ Error routing analyzed media to Agent:', agentError);
            }

          } else if (result.action === 'ASK') {
            // Low confidence - ask user for confirmation
            console.log(`❓ Low confidence - asking user`);

            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_NUMBER,
              to: from,
              body: result.message
            });

          } else if (result.action === 'CHAT') {
            // Voice message treated as chat (not saved) - Route to Agent
            console.log(`💬 Voice message treated as chat - routing to Agent`);

            if (result.transcribedText && result.transcribedText.trim()) {
              try {
                // Retrieve conversation history
                const history = await getConversationHistory(from, 10);

                // Process transcribed text through AgentService with voice context
                const agentResponse = await processAgentMessage({
                  userMessage: result.transcribedText,
                  conversationHistory: history,
                  phoneNumber: from,
                  hasMediaAttached: true,
                  mediaType: 'audio/voice',
                  mediaAnalysis: null,
                  isVoice: true,  // CRITICAL: Inform Agent this came from voice transcription
                  replyContext: replyContext // Pass reply context if user is replying to a document/message
                });

                if (agentResponse.success) {
                  // Save user's transcribed message to history
                  await saveMessageToHistory(from, 'user', result.transcribedText);

                  // Save AI response to history
                  await saveMessageToHistory(from, 'assistant', agentResponse.response);

                  // Send AI response to user
                  await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_NUMBER,
                    to: from,
                    body: agentResponse.response
                  });

                  console.log(`✅ Agent processed voice message and replied`);
                } else {
                  console.error('❌ Agent processing failed:', agentResponse.error);
                  await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_NUMBER,
                    to: from,
                    body: 'Lo siento, tuve un problema procesando tu mensaje de voz. Por favor, intenta de nuevo.'
                  });
                }
              } catch (agentError) {
                console.error('❌ Error routing voice to Agent:', agentError);
                await twilioClient.messages.create({
                  from: process.env.TWILIO_WHATSAPP_NUMBER,
                  to: from,
                  body: 'Lo siento, tuve un problema procesando tu mensaje de voz.'
                });
              }
            } else {
              console.warn('⚠️  CHAT action but no transcribedText found');
            }

          } else if (result.action === 'ERROR') {
            // Error occurred during processing
            console.error(`❌ Error processing media: ${result.error}`);

            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_NUMBER,
              to: from,
              body: result.message
            });
          }

        } catch (error) {
          console.error(`❌ Error processing media ${i}:`, error);
          console.error(`   Stack:`, error.stack);

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
      try {
        // Check for recent media in conversation context
        const recentMedia = getRecentMedia(phoneNumber);

        // Retrieve conversation history from MongoDB
        const history = await getConversationHistory(from, 10);

        // If there's recent media, the text might be a follow-up question about it
        if (recentMedia) {
          console.log(`📎 Found recent media in context (${recentMedia.ageSeconds}s ago) - linking to message`);
        }

        // Process message through AgentService (includes user lookup and context injection)
        const agentResponse = await processAgentMessage({
          userMessage: incomingMsg,
          conversationHistory: history,
          phoneNumber: from,
          hasMediaAttached: recentMedia ? true : false,
          mediaType: recentMedia ? recentMedia.mediaType : null,
          mediaAnalysis: recentMedia ? recentMedia.analysis : null,
          replyContext: replyContext // Pass reply context if user is replying to a document/message
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

        // Save user message to MongoDB
        await saveMessageToHistory(from, 'user', incomingMsg);

        // Save AI response to MongoDB
        await saveMessageToHistory(from, 'assistant', agentResponse.response);

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

          // Process with MediaProcessor (already saves to R2 and MongoDB internally)
          const result = await processEmailAttachment({
            attachmentBuffer,
            filename,
            mimeType: contentType,
            ownerPhoneNumber: user.phoneNumber,
            ownerTitle: user.title || user.name,
            emailSubject: subject
          });

          savedFiles.push(result);
          console.log(`✅ Saved email attachment: ${result.filename}`);

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
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Admin endpoint to seed/update user data
app.get('/admin/seed', async (req, res) => {
  try {
    console.log('\n🌱 Admin seed endpoint triggered\n');

    // Master User List
    const USERS = [
      {
        phone: '+18096510177',
        alias: 'sr. max',
        fullName: 'Max Alejandro Mejia Gonzalez',
        displayName: 'Max Mejia',
        email: 'mxmejia13@gmail.com'
      },
      {
        phone: '+18098903565',
        alias: 'sr. vinicio',
        fullName: 'Vinicio Alfredo Mejia Gonzalez',
        displayName: 'Vinicio Mejia',
        email: 'viniciomejia5@gmail.com'
      },
      {
        phone: '+18293803443',
        alias: 'sr. sebastian',
        fullName: 'Sebastian Andres Mejia Gonzalez',
        displayName: 'Sebastian Mejia',
        email: 'sebastianandresmejiagonzalez@gmail.com'
      },
      {
        phone: '+18093833443',
        alias: 'sr. pally',
        fullName: 'Vinicio Alfredo Mejia Medina',
        displayName: 'Vinicio Medina',
        email: 'viniciomejia@yahoo.com'
      },
      {
        phone: '+18292995088',
        alias: 'sr. jose',
        fullName: 'Jose Ismael Medina Reyes',
        displayName: 'Jose Medina',
        email: ''
      }
    ];

    const results = [];

    for (const userData of USERS) {
      const userDoc = {
        phoneNumber: userData.phone,
        alias: userData.alias,
        fullName: userData.fullName,
        name: userData.displayName, // SHORT display name
        email: userData.email || '',
        title: userData.alias
      };

      // Remove empty email to avoid validation issues
      if (!userDoc.email) {
        delete userDoc.email;
      }

      // First remove isAdmin field
      await User.updateOne(
        { phoneNumber: userData.phone },
        { $unset: { isAdmin: 1 } }
      );

      // Then upsert the user data
      const user = await User.findOneAndUpdate(
        { phoneNumber: userData.phone },
        {
          $set: userDoc,
          $setOnInsert: {
            createdAt: new Date(),
            totalFiles: 0,
            totalMessages: 0,
            preferences: {}
          }
        },
        {
          upsert: true,
          new: true,
          runValidators: true
        }
      );

      // Convert to plain object to access fields properly
      const userObj = user.toObject();

      console.log(`✅ Upserted: ${userObj.alias} (${userObj.phoneNumber})`);
      console.log(`   Full Name: ${userObj.fullName}, Email: ${userObj.email}`);

      results.push({
        success: true,
        alias: userObj.alias,
        fullName: userObj.fullName,
        phone: userObj.phoneNumber,
        email: userObj.email || 'N/A',
        name: userObj.name,
        title: userObj.title
      });
    }

    console.log(`\n✅ Successfully seeded ${results.length} users\n`);

    res.json({
      success: true,
      message: `Successfully seeded ${results.length} users`,
      users: results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Seed endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Fix corrupted dates from manual MongoDB edits
app.get('/admin/fix-dates', async (req, res) => {
  try {
    console.log('\n🔧 Fixing corrupted date fields...\n');

    const collection = mongoose.connection.collection('users');

    // Find all users with corrupted dates
    const users = await collection.find({}).toArray();

    const fixed = [];

    for (const user of users) {
      const updates = {};

      // Fix createdAt if it's an object with $date
      if (user.createdAt && typeof user.createdAt === 'object' && user.createdAt.$date) {
        updates.createdAt = new Date(user.createdAt.$date);
      }

      // Fix lastActive if it's an object with $date
      if (user.lastActive && typeof user.lastActive === 'object' && user.lastActive.$date) {
        updates.lastActive = new Date(user.lastActive.$date);
      }

      // Fix v2LaunchNotifiedAt if it exists and is corrupted
      if (user.v2LaunchNotifiedAt && typeof user.v2LaunchNotifiedAt === 'object' && user.v2LaunchNotifiedAt.$date) {
        updates.v2LaunchNotifiedAt = new Date(user.v2LaunchNotifiedAt.$date);
      }

      if (Object.keys(updates).length > 0) {
        await collection.updateOne(
          { _id: user._id },
          { $set: updates }
        );

        fixed.push({
          phone: user.phoneNumber,
          alias: user.alias,
          fixedFields: Object.keys(updates)
        });

        console.log(`✅ Fixed dates for ${user.alias || user.phoneNumber}`);
      }
    }

    console.log(`\n✅ Fixed ${fixed.length} users\n`);

    res.json({
      success: true,
      message: `Fixed date fields for ${fixed.length} users`,
      fixed: fixed,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Fix dates error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
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
