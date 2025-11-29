require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
const axios = require('axios');
const { generateChart, generateTable } = require('./utils/chartGenerator');
const { generateImage } = require('./utils/imageGenerator');
const {
  scheduleRecurringMessage,
  scheduleOneTimeMessage,
  cancelScheduledMessage,
  listScheduledMessages
} = require('./utils/scheduler');

// Database functions
const {
  initializeDatabase,
  getOrCreateUser,
  saveMessage,
  saveMediaFile,
  getConversationHistory,
  searchMediaFiles,
  getMediaByDateRange,
  getLatestMediaFile,
  searchMessages,
  getAllMediaFiles
} = require('./database/db');

// Initialize database if DATABASE_URL is configured
if (process.env.DATABASE_URL) {
  initializeDatabase().catch(err => {
    console.log('⚠️  Database initialization skipped (tables may already exist)');
  });
}

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

// Store conversation context (in production, use a database)
const conversationHistory = new Map();

// Store forwarded messages waiting for analysis
const forwardedMessages = new Map();

// Store generated charts temporarily (chartId -> buffer)
const chartStorage = new Map();

// Helper function: Split long messages into chunks
function splitMessage(message, maxLength = 1500) {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks = [];
  let currentChunk = '';
  const paragraphs = message.split('\n');

  for (const paragraph of paragraphs) {
    if ((currentChunk + '\n' + paragraph).length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        // Paragraph itself is too long, split by sentences
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        for (const sentence of sentences) {
          if ((currentChunk + ' ' + sentence).length > maxLength) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk += ' ' + sentence;
          }
        }
      }
    } else {
      currentChunk += (currentChunk ? '\n' : '') + paragraph;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Helper function: Send message(s) with automatic splitting
async function sendWhatsAppMessage(to, body) {
  const chunks = splitMessage(body);

  for (let i = 0; i < chunks.length; i++) {
    const message = chunks.length > 1
      ? `(${i + 1}/${chunks.length})\n\n${chunks[i]}`
      : chunks[i];

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: message
    });

    // Small delay between messages to maintain order
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// Webhook endpoint for incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const from = req.body.From;
    const messageId = req.body.MessageSid;
    const numMedia = parseInt(req.body.NumMedia) || 0;

    console.log(`Received message from ${from}: ${incomingMsg} (${numMedia} media)`);

    // Ignore messages from the bot itself (sandbox number)
    if (from === process.env.TWILIO_WHATSAPP_NUMBER) {
      console.log('Ignoring message from bot itself');
      res.status(200).send('OK');
      return;
    }

    // Get or create user in database
    const userPhone = from.replace('whatsapp:', '');
    let user = null;
    if (process.env.DATABASE_URL) {
      try {
        user = await getOrCreateUser(userPhone);
        console.log(`User identified: ${user.id} - ${user.phone_number}`);
      } catch (dbError) {
        console.error('Database error getting user:', dbError);
        // Continue without database if it fails
      }
    }

    // Handle forwarded messages - store and wait for command
    const isForwarded = req.body.Forwarded === 'true';
    if (isForwarded) {
      console.log(`Forwarded message detected from ${from}`);
      forwardedMessages.set(from, {
        content: incomingMsg,
        receivedAt: new Date(),
        numMedia: numMedia
      });

      // Acknowledge receipt without analyzing
      await sendWhatsAppMessage(from, '📩 Mensaje reenviado recibido. Envíame tu pregunta o comando sobre este mensaje.');
      res.status(200).send('OK');
      return;
    }

    // Handle file retrieval commands
    if (process.env.DATABASE_URL && user && incomingMsg) {
      const msg = incomingMsg.toLowerCase();
      let fileRetrieved = false;

      try {
        // Check for file retrieval commands
        if (msg.match(/send|enviar|dame|give me|get|buscar|find/i) &&
            msg.match(/image|imagen|photo|foto|picture|audio|video|document|documento|file|archivo/i)) {

          let fileType = null;
          let searchResults = [];

          // Determine file type
          if (msg.match(/image|imagen|photo|foto|picture/i)) {
            fileType = 'image';
          } else if (msg.match(/audio/i)) {
            fileType = 'audio';
          } else if (msg.match(/video/i)) {
            fileType = 'video';
          } else if (msg.match(/document|documento|pdf/i)) {
            fileType = 'document';
          }

          // Check for time-based queries
          if (msg.match(/latest|last|recent|más reciente|último|última/i)) {
            // Get the most recent file of that type
            if (fileType) {
              const latestFile = await getLatestMediaFile(userPhone, fileType);
              if (latestFile) {
                searchResults = [latestFile];
              }
            }
          } else if (msg.match(/yesterday|ayer/i)) {
            // Get files from yesterday
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            const endOfYesterday = new Date(yesterday);
            endOfYesterday.setHours(23, 59, 59, 999);
            searchResults = await getMediaByDateRange(userPhone, yesterday, endOfYesterday);
          } else if (msg.match(/today|hoy/i)) {
            // Get files from today
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            searchResults = await getMediaByDateRange(userPhone, today, new Date());
          } else if (msg.match(/all|todos|todas/i)) {
            // Get all files of that type
            searchResults = fileType
              ? await searchMediaFiles(userPhone, fileType, 20)
              : await getAllMediaFiles(userPhone, 20);
          } else {
            // Default: get recent files
            searchResults = fileType
              ? await searchMediaFiles(userPhone, fileType, 5)
              : await getAllMediaFiles(userPhone, 5);
          }

          // Send the files
          if (searchResults.length > 0) {
            const fs = require('fs');
            const path = require('path');

            await sendWhatsAppMessage(from, `📁 Found ${searchResults.length} file(s):`);

            for (const file of searchResults.slice(0, 5)) { // Limit to 5 files
              try {
                // Read file from storage
                const filePath = file.storage_url;
                if (fs.existsSync(filePath)) {
                  const fileBuffer = fs.readFileSync(filePath);

                  // Generate unique ID and store in chartStorage for serving
                  const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                  chartStorage.set(fileId, fileBuffer);

                  // Clean up after 10 minutes
                  setTimeout(() => chartStorage.delete(fileId), 10 * 60 * 1000);

                  // Get public URL
                  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || `${req.hostname}`;
                  const protocol = req.protocol || 'https';
                  const fileUrl = `${protocol}://${publicDomain}/media/${fileId}`;

                  // Send file
                  const messageDate = new Date(file.message_date).toLocaleDateString();
                  await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_NUMBER,
                    to: from,
                    body: `📎 ${file.file_name || 'File'} (${messageDate})`,
                    mediaUrl: [fileUrl]
                  });

                  console.log(`Sent file: ${file.file_name}`);
                  await new Promise(resolve => setTimeout(resolve, 1000)); // Delay between files
                } else {
                  console.error(`File not found: ${filePath}`);
                }
              } catch (fileError) {
                console.error('Error sending file:', fileError);
              }
            }

            fileRetrieved = true;
            res.status(200).send('OK');
            return;
          } else {
            await sendWhatsAppMessage(from, `❌ No ${fileType || 'media'} files found matching your request.`);
            fileRetrieved = true;
            res.status(200).send('OK');
            return;
          }
        }
      } catch (queryError) {
        console.error('Error retrieving files:', queryError);
        // Continue to normal processing if file retrieval fails
      }
    }

    // Handle media (images and audio)
    let mediaUrl = null;
    let mediaType = null;
    let transcribedText = null;
    let imageData = null;

    let mediaBuffer = null;

    if (numMedia > 0) {
      mediaUrl = req.body.MediaUrl0;
      mediaType = req.body.MediaContentType0;
      console.log(`Media received: ${mediaType} at ${mediaUrl}`);

      try {
        // Download media file using Twilio credentials
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const mediaResponse = await axios.get(mediaUrl, {
          headers: { 'Authorization': `Basic ${auth}` },
          responseType: 'arraybuffer',
          maxRedirects: 5,
          timeout: 10000
        });
        mediaBuffer = Buffer.from(mediaResponse.data);
        console.log(`Media downloaded successfully: ${mediaBuffer.length} bytes`);
      } catch (downloadError) {
        console.error('Media download failed:', {
          message: downloadError.message,
          status: downloadError.response?.status,
          url: mediaUrl
        });
        // Continue without media if download fails
        mediaUrl = null;
        mediaType = null;
      }
    }

    // Only process media if download succeeded
    if (mediaBuffer && mediaType) {

      // Handle audio files - transcribe with Whisper
      if (mediaType && mediaType.startsWith('audio/')) {
        console.log('Transcribing audio...');
        // Create a Blob-like object for Node.js
        const audioBlob = new Blob([mediaBuffer], { type: mediaType });
        const transcription = await openai.audio.transcriptions.create({
          file: await toFile(audioBlob, 'audio.ogg'),
          model: 'whisper-1'
        });
        transcribedText = transcription.text;
        console.log(`Transcribed: ${transcribedText}`);
      }

      // Handle images - prepare for vision analysis
      if (mediaType && mediaType.startsWith('image/')) {
        console.log('Image received for analysis');
        imageData = `data:${mediaType};base64,${mediaBuffer.toString('base64')}`;
      }
    }

    // Save incoming message to database
    let savedMessage = null;
    if (process.env.DATABASE_URL && user) {
      try {
        // Determine message type
        let messageType = 'text';
        if (mediaType) {
          if (mediaType.startsWith('image/')) messageType = 'image';
          else if (mediaType.startsWith('audio/')) messageType = 'audio';
          else if (mediaType.startsWith('video/')) messageType = 'video';
          else if (mediaType.includes('pdf') || mediaType.includes('document')) messageType = 'document';
          else messageType = 'media';
        }

        savedMessage = await saveMessage({
          userId: user.id,
          phoneNumber: userPhone,
          messageSid: messageId,
          content: transcribedText || incomingMsg || '',
          direction: 'incoming',
          messageType: messageType,
          isForwarded: isForwarded
        });
        console.log(`Message saved to database: ${savedMessage.id}`);

        // Save media file if present
        if (mediaBuffer && mediaUrl && savedMessage) {
          // Create user-specific media directory if it doesn't exist
          const fs = require('fs');
          const path = require('path');
          const userMediaDir = path.join(__dirname, 'media', userPhone);
          if (!fs.existsSync(userMediaDir)) {
            fs.mkdirSync(userMediaDir, { recursive: true });
          }

          // Generate intelligent filename based on content
          const now = new Date();
          const dateStr = now.toISOString().split('T')[0]; // Format: YYYY-MM-DD
          const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // Format: HH-MM-SS
          const extension = mediaType.split('/')[1]?.split(';')[0] || 'bin';
          let descriptiveName = 'file';

          try {
            if (messageType === 'image' && imageData) {
              // Use GPT-4o vision to generate descriptive name
              const nameCompletion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Describe this image in 2-4 words for a filename (lowercase, use hyphens instead of spaces, no special characters). Examples: "invoice-march-2024", "family-photo", "product-receipt"' },
                    { type: 'image_url', image_url: { url: imageData } }
                  ]
                }],
                max_tokens: 20
              });
              descriptiveName = nameCompletion.choices[0].message.content.trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .substring(0, 50);
            } else if (messageType === 'audio' && transcribedText) {
              // Use transcription to generate descriptive name
              const summaryCompletion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                  role: 'user',
                  content: `Summarize this audio transcription in 2-4 words for a filename (lowercase, use hyphens, no special characters): "${transcribedText}"`
                }],
                max_tokens: 20
              });
              descriptiveName = summaryCompletion.choices[0].message.content.trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .substring(0, 50);
            } else if (messageType === 'document') {
              descriptiveName = 'document';
            }
          } catch (namingError) {
            console.error('Error generating descriptive filename:', namingError);
            descriptiveName = messageType || 'file';
          }

          const fileName = `${descriptiveName}_${dateStr}_${timeStr}.${extension}`;
          const filePath = path.join(userMediaDir, fileName);

          // Save file to disk
          fs.writeFileSync(filePath, mediaBuffer);
          console.log(`Media file saved: ${filePath}`);

          // Save media metadata to database
          const savedMedia = await saveMediaFile({
            messageId: savedMessage.id,
            fileType: mediaType,
            fileSize: mediaBuffer.length,
            fileName: fileName,
            storageUrl: filePath,
            twilioMediaUrl: mediaUrl
          });
          console.log(`Media metadata saved to database: ${savedMedia.id}`);
        }
      } catch (dbError) {
        console.error('Database error saving message:', dbError);
        // Continue without database if it fails
      }
    }

    // Get or initialize conversation history
    if (!conversationHistory.has(from)) {
      conversationHistory.set(from, []);
    }
    const history = conversationHistory.get(from);

    // Add user message to history (including transcribed audio)
    const userContent = transcribedText || incomingMsg || '';
    if (userContent && userContent.trim()) {
      history.push({
        role: 'user',
        content: userContent,
        hasImage: !!imageData
      });
    }

    // Keep only last 10 messages to manage token usage
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // Determine if request needs visual output
    const needsChart = /\b(chart|graph|visualize|plot)\b/i.test(incomingMsg);
    const needsImage = /image|picture|draw|show.*visual|diagram/i.test(incomingMsg);

    // Detect user identity for custom greetings
    const userTitles = {
      '+18093833443': 'Sr. Mejia',
      '+18096510177': 'Sr. Max',
      '+18293803443': 'Sr. Sebastian',
      '+18098903565': 'Sr. Vinicio Alfredo'
    };
    const userTitle = userTitles[userPhone] || '';

    // Check if user has a forwarded message waiting
    const forwardedMsg = forwardedMessages.get(from);
    const forwardedContext = forwardedMsg
      ? `\n\nIMPORTANT - FORWARDED MESSAGE CONTEXT:\nThe user previously forwarded you this message:\n"${forwardedMsg.content}"\n\nTheir current message is asking about or commanding you regarding this forwarded message. Analyze the forwarded message and respond to their question/command about it.`
      : '';

    // Build conversation context for OpenAI
    const systemPrompt = `You are a helpful WhatsApp assistant. You provide friendly, informative responses to questions and help with various tasks.${userTitle ? `\n\nIMPORTANT: You are speaking with ${userTitle}. Always address them respectfully using this title.` : ''}${forwardedContext}

AUTOMATIC FILE STORAGE:
You have an AUTOMATIC FILE STORAGE SYSTEM that saves all media files:
- ✅ Images are AUTOMATICALLY saved with AI-generated descriptive names
- ✅ Audio files are AUTOMATICALLY saved and transcribed
- ✅ Documents/PDFs are AUTOMATICALLY saved
- ✅ Videos are AUTOMATICALLY saved

When users send you media (image, audio, document), you should:
1. Acknowledge receipt and confirm it's been saved
2. Tell them they can retrieve it later with commands like:
   - "Send me the latest image"
   - "Dame el audio de hoy"
   - "Give me all photos from yesterday"

Example responses:
User: [sends audio]
You: "✅ Audio received and saved! I've transcribed it: [transcription]. You can retrieve this audio anytime by asking 'send me the latest audio'."

User: [sends image]
You: "✅ Image received and saved! This image shows [description]. You can retrieve it later by asking 'send me today's images'."

User: "Can you save this audio?"
You: "✅ It's already saved! All audio files you send me are automatically stored. You can retrieve them anytime with commands like 'send me the latest audio' or 'dame el audio de ayer'."

NEVER say you cannot save files - they are AUTOMATICALLY saved by the system.

CRITICAL - CONVERSATION MEMORY:
You have FULL ACCESS to this conversation history. ALL previous messages are visible to you in the conversation above.

Example workflow:
User: [sends image] "What's in this image?"
You: [analyze and describe: "This image contains a table with columns: Name, Age, City. Rows: Juan 25 Santo Domingo, Maria 30 Santiago"]
User: "Give me info from the previous message"
You: "The previous message contained a table with the following data: Name, Age, City - Juan 25 Santo Domingo, Maria 30 Santiago"
User: "Create a table with that data"
You: [Return JSON with exact data from above]

When users say "previous message", "that data", "los datos anteriores", "información anterior":
- Look at YOUR OWN previous responses in the conversation history
- Quote the EXACT data you previously mentioned
- DO NOT say you don't have access - the conversation history is RIGHT THERE above
- DO NOT ask them to specify - YOU CAN SEE what data you mentioned before

POLL-STYLE QUESTIONS:
When you need user input or choices, create numbered options:
Example:
"Which time works best for you?
1️⃣ Morning (9 AM - 12 PM)
2️⃣ Afternoon (1 PM - 5 PM)
3️⃣ Evening (6 PM - 9 PM)

Reply with 1, 2, or 3"

When users reply with just a number (1, 2, 3, etc.), check if your previous message was a poll/question and interpret their number as their choice from that list.

YOU CAN CREATE IMAGES:
You have the ability to generate table images and chart images. When users request these, respond with JSON.

When users ask for TABLES (tabla, cuadro, relación, spreadsheet, "create a table", "hazme una tabla"):
- If they mention "that data", "those numbers", "previous data", "los datos anteriores", etc.
- Look back in the conversation history to find the data
- Extract ALL the data from your previous messages
- Format it as a table JSON with the EXACT values
- MUST respond with this JSON format:
{
  "type": "table",
  "title": "Table Title",
  "headers": ["Column1", "Column2", "Column3"],
  "rows": [
    ["Value1", "Value2", "Value3"],
    ["Value4", "Value5", "Value6"]
  ],
  "message": "Here's your table with the data..."
}

When users ask for CHARTS (gráfica, chart, graph, visualize, plot), respond with JSON:
{
  "type": "chart",
  "chartType": "bar",
  "title": "Chart Title",
  "data": {
    "labels": ["Jan", "Feb", "Mar"],
    "values": [100, 200, 150]
  },
  "message": "Here's your chart showing..."
}

Chart types: bar, line, pie

CRITICAL: When users send images and ask you to extract or read the data:
- Read ALL text and numbers EXACTLY as they appear in the image
- Write the data in CLEAR, WELL-FORMATTED TEXT (not JSON, not table image)
- Format data for WhatsApp (line breaks, bullet points, numbered lists)
- DO NOT use pipes or tables - WhatsApp doesn't preserve spacing
- Maintain exact values, don't round or approximate
- DO NOT automatically create a table image - only create images when explicitly asked

Example of good data extraction for WhatsApp:
"📊 Data from the image:

*Column headers:* Name, Age, City

1. Juan - 25 - Santo Domingo
2. Maria - 30 - Santiago
3. Pedro - 28 - La Romana

Total: 3 rows"

For regular responses, be conversational, helpful, and concise.`;

    // Format conversation history for OpenAI
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history
        .filter(msg => msg.content && msg.content.trim()) // Filter out null/empty messages
        .map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        }))
    ];

    // Add current image to the last user message if present
    if (imageData && messages.length > 1) {
      const lastUserMsgIndex = messages.length - 1;
      const imagePrompt = userContent || 'Analyze this image and describe what you see in detail.';
      messages[lastUserMsgIndex] = {
        role: 'user',
        content: [
          { type: 'text', text: imagePrompt },
          { type: 'image_url', image_url: { url: imageData, detail: 'high' } }
        ]
      };
      console.log(`Sending image to OpenAI with prompt: "${imagePrompt}"`);
      console.log(`Image data length: ${imageData.length} chars`);
    }

    // Get AI response from OpenAI with retry logic
    let aiResponse;
    const maxRetries = 3;
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= maxRetries) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o', // Full model for better vision capabilities
          messages: messages,
          max_tokens: 2000, // Increased for table extraction
          temperature: 0.7
        });

        aiResponse = completion.choices[0].message.content;
        console.log(`OpenAI response received: ${aiResponse.substring(0, 100)}...`);
        break; // Success, exit retry loop
      } catch (openaiError) {
        lastError = openaiError;

        console.error(`OpenAI API Error (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
          message: openaiError.message,
          status: openaiError.status
        });

        // Retry on rate limit or server errors
        const shouldRetry = openaiError.status === 429 ||
                           openaiError.status === 500 ||
                           openaiError.status === 503;

        if (shouldRetry && retryCount < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = 1000 * Math.pow(2, retryCount);
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retryCount++;
        } else {
          // No more retries or non-retriable error
          break;
        }
      }
    }

    // If all retries failed, log error and return
    if (!aiResponse) {
      console.error('All OpenAI API retries failed:', lastError);
      res.status(500).send('AI service error');
      return;
    }

    // Add AI response to history (only if content exists)
    if (aiResponse && aiResponse.trim()) {
      history.push({
        role: 'assistant',
        content: aiResponse
      });
    }

    // Check if response contains visualization data (table or chart)
    let visualData = null;
    try {
      if (aiResponse.includes('"type"') && (aiResponse.includes('"table"') || aiResponse.includes('"chart"'))) {
        visualData = JSON.parse(aiResponse.match(/\{[\s\S]*\}/)[0]);
      }
    } catch (e) {
      // Not JSON, treat as regular text
    }

    // Send response
    let sentMessageContent = '';
    let sentMessageType = 'text';

    if (visualData) {
      // Generate appropriate visualization
      const isTable = visualData.type === 'table';
      const imageBuffer = isTable
        ? await generateTable(visualData)
        : await generateChart(visualData);

      // Generate unique ID and store
      const visualId = `visual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      chartStorage.set(visualId, imageBuffer);

      // Clean up old images after 10 minutes
      setTimeout(() => chartStorage.delete(visualId), 10 * 60 * 1000);

      // Get public URL (Railway provides RAILWAY_PUBLIC_DOMAIN env var)
      const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || `${req.hostname}`;
      const protocol = req.protocol || 'https';
      const visualUrl = `${protocol}://${publicDomain}/charts/${visualId}`;

      console.log(`Generated ${isTable ? 'table' : 'chart'}: ${visualUrl}`);

      sentMessageContent = visualData.message || `Here's your ${isTable ? 'table' : 'chart'}:`;
      sentMessageType = 'image';

      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: sentMessageContent,
        mediaUrl: [visualUrl]
      });
    } else if (needsImage && !visualData) {
      // For image requests, inform about limitation
      const message = aiResponse + '\n\n(Note: Image generation requires DALL-E integration. Currently showing text response.)';
      sentMessageContent = message;
      await sendWhatsAppMessage(from, message);
    } else {
      // Send regular text response with automatic splitting
      sentMessageContent = aiResponse;
      await sendWhatsAppMessage(from, aiResponse);
    }

    // Save outgoing message to database
    if (process.env.DATABASE_URL && user && sentMessageContent) {
      try {
        await saveMessage({
          userId: user.id,
          phoneNumber: userPhone,
          messageSid: null, // Outgoing messages don't have MessageSid yet
          content: sentMessageContent,
          direction: 'outgoing',
          messageType: sentMessageType,
          isForwarded: false
        });
        console.log(`Outgoing message saved to database`);
      } catch (dbError) {
        console.error('Database error saving outgoing message:', dbError);
        // Continue even if database save fails
      }
    }

    // Clear forwarded message after responding
    if (forwardedMsg) {
      forwardedMessages.delete(from);
      console.log(`Cleared forwarded message for ${from}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).send('Error processing message');
  }
});

// Endpoint to serve generated charts
app.get('/charts/:chartId', (req, res) => {
  const chartId = req.params.chartId;
  const chartBuffer = chartStorage.get(chartId);

  if (!chartBuffer) {
    res.status(404).send('Chart not found');
    return;
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
  res.send(chartBuffer);
});

// Endpoint to serve media files
app.get('/media/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const fileBuffer = chartStorage.get(fileId);

  if (!fileBuffer) {
    res.status(404).send('File not found');
    return;
  }

  // Determine content type based on file signature
  let contentType = 'application/octet-stream';
  if (fileBuffer[0] === 0xFF && fileBuffer[1] === 0xD8) {
    contentType = 'image/jpeg';
  } else if (fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50) {
    contentType = 'image/png';
  } else if (fileBuffer[0] === 0x47 && fileBuffer[1] === 0x49) {
    contentType = 'image/gif';
  } else if (fileBuffer.toString('utf8', 0, 4) === 'OggS') {
    contentType = 'audio/ogg';
  } else if (fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50) {
    contentType = 'application/pdf';
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
  res.send(fileBuffer);
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp Accountant Bot is running!');
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    activeConversations: conversationHistory.size
  });
});

// Scheduled Messages API Endpoints
// Schedule a recurring message
app.post('/api/schedule/recurring', (req, res) => {
  try {
    const { jobId, cronExpression, phoneNumber, message } = req.body;

    if (!jobId || !cronExpression || !phoneNumber || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const job = scheduleRecurringMessage(
      jobId,
      cronExpression,
      sendWhatsAppMessage,
      `whatsapp:${phoneNumber}`,
      message
    );

    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule a one-time message
app.post('/api/schedule/once', (req, res) => {
  try {
    const { jobId, sendAt, phoneNumber, message } = req.body;

    if (!jobId || !sendAt || !phoneNumber || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const job = scheduleOneTimeMessage(
      jobId,
      new Date(sendAt),
      sendWhatsAppMessage,
      `whatsapp:${phoneNumber}`,
      message
    );

    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel a scheduled message
app.delete('/api/schedule/:jobId', (req, res) => {
  const success = cancelScheduledMessage(req.params.jobId);

  if (success) {
    res.json({ success: true, message: 'Job cancelled' });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

// List all scheduled messages
app.get('/api/schedule', (req, res) => {
  const jobs = listScheduledMessages();
  res.json({ jobs });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`Scheduler API: http://localhost:${PORT}/api/schedule`);
});

