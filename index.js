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
  searchMediaByDescription,
  getMediaByDateRange,
  getLatestMediaFile,
  searchMessages,
  getAllMediaFiles
} = require('./database/db');

// Initialize database if DATABASE_URL is configured
if (process.env.DATABASE_URL) {
  console.log('✅ DATABASE_URL is configured');
  initializeDatabase().catch(err => {
    console.log('⚠️  Database initialization skipped (tables may already exist)');
  });
} else {
  console.error('❌ WARNING: DATABASE_URL is NOT configured!');
  console.error('❌ File storage and retrieval will NOT work without a database!');
  console.error('❌ Please add DATABASE_URL environment variable in Railway');
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

    // IMPORTANT: Only handle file retrieval queries if NO media is attached
    // If media is attached, we'll save it first and confirm - NOT search for files
    const hasMediaAttached = numMedia > 0;

    // Handle file retrieval commands (ONLY for text-only messages)
    if (!hasMediaAttached && process.env.DATABASE_URL && user && incomingMsg) {
      const msg = incomingMsg.toLowerCase();

      try {
        // Use AI to detect if this is a file-related query
        const isFileQuery = msg.match(/file|archivo|image|imagen|photo|foto|audio|video|document|documento|pdf|picture|sent|envié|guardado|saved|name|nombre|último|latest|ayer|yesterday|today|hoy|how many|cuánto|list|lista/i);

        if (isFileQuery) {
          console.log('🔍 Potential file query detected:', incomingMsg);

          // Use GPT-4o to interpret the user's intent with context awareness
          const intentCompletion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
              role: 'user',
              content: `You are analyzing a user's request for files. Understand their INTENT regardless of exact wording.

User query: "${incomingMsg}"

Respond with ONLY a JSON object:

{
  "action": "retrieve|info|list|none",
  "fileType": "image|audio|video|document|null",
  "timeframe": "latest|today|yesterday|all|null",
  "infoType": "filename|count|date|all|null",
  "searchQuery": "key terms or null",
  "confidence": "high|medium|low"
}

**Understanding Intent Examples:**

"Mandame una foto de mi cedula" → User wants their cedula PHOTO sent back
→ {"action":"retrieve","fileType":"image","timeframe":"all","infoType":null,"searchQuery":"cedula identificacion ID card","confidence":"high"}

"enviame la imagen que te habia enviado" → User wants a previous image
→ {"action":"retrieve","fileType":"image","timeframe":"latest","infoType":null,"searchQuery":null,"confidence":"medium"}

"Dame el audio" → User wants latest audio file
→ {"action":"retrieve","fileType":"audio","timeframe":"latest","infoType":null,"searchQuery":null,"confidence":"high"}

"Como se llama el ultimo audio?" → User wants filename info
→ {"action":"info","fileType":"audio","timeframe":"latest","infoType":"filename","searchQuery":null,"confidence":"high"}

"Envíame la factura de marzo" → User wants invoice from March
→ {"action":"retrieve","fileType":"image","timeframe":"all","infoType":null,"searchQuery":"factura invoice marzo march","confidence":"high"}

"Send me my ID" → User wants ID/cedula
→ {"action":"retrieve","fileType":"image","timeframe":"all","infoType":null,"searchQuery":"cedula ID identification card","confidence":"high"}

**Rules:**
- searchQuery should include SYNONYMS in both English & Spanish (cedula = ID = identification = cédula)
- Set confidence based on clarity of request
- If unsure, set confidence "low"

Respond with ONLY the JSON object:`
            }],
            max_tokens: 150
          });

          let intent;
          try {
            const intentText = intentCompletion.choices[0].message.content.trim();
            console.log('📋 Intent response:', intentText);
            intent = JSON.parse(intentText.match(/\{[\s\S]*\}/)[0]);
          } catch (parseError) {
            console.error('❌ Failed to parse intent:', parseError);
            // Continue to normal processing if intent parsing fails
            throw new Error('Intent parsing failed');
          }

          console.log('✅ Detected intent:', JSON.stringify(intent));

          // If not a file query, continue to normal processing
          if (intent.action === 'none') {
            console.log('ℹ️  Not a file query, continuing to normal chat');
            throw new Error('Not a file query');
          }

          // If confidence is low, ask for clarification before searching
          if (intent.confidence === 'low') {
            console.log('⚠️  Low confidence - asking for clarification');
            await sendWhatsAppMessage(from, `No estoy seguro de qué archivo buscas. ¿Podrías ser más específico? Por ejemplo:\n- "Mándame mi cédula"\n- "Envíame el audio de hoy"\n- "Dame la factura de marzo"`);
            res.status(200).send('OK');
            return;
          }

          let searchResults = [];
          const fileType = intent.fileType;

          // Use semantic search if searchQuery is provided
          if (intent.searchQuery) {
            console.log(`🔍 Performing semantic search for: "${intent.searchQuery}"`);
            searchResults = await searchMediaByDescription(userPhone, intent.searchQuery, 10);
            console.log(`✅ Semantic search found ${searchResults.length} files`);
          } else {
            console.log(`🔎 Searching for ${fileType || 'any'} files with timeframe: ${intent.timeframe}`);

            // Execute appropriate query based on timeframe
            if (intent.timeframe === 'latest') {
              if (fileType) {
                const latestFile = await getLatestMediaFile(userPhone, fileType);
                if (latestFile) {
                  searchResults = [latestFile];
                }
              } else {
                searchResults = await getAllMediaFiles(userPhone, 1);
              }
            } else if (intent.timeframe === 'yesterday') {
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
              yesterday.setHours(0, 0, 0, 0);
              const endOfYesterday = new Date(yesterday);
              endOfYesterday.setHours(23, 59, 59, 999);
              searchResults = await getMediaByDateRange(userPhone, yesterday, endOfYesterday);
              if (fileType) {
                searchResults = searchResults.filter(f => f.file_type.startsWith(fileType));
              }
            } else if (intent.timeframe === 'today') {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              searchResults = await getMediaByDateRange(userPhone, today, new Date());
              if (fileType) {
                searchResults = searchResults.filter(f => f.file_type.startsWith(fileType));
              }
            } else if (intent.timeframe === 'all') {
              searchResults = fileType
                ? await searchMediaFiles(userPhone, fileType, 20)
                : await getAllMediaFiles(userPhone, 20);
            }
          }

          // Handle different actions
          if (intent.action === 'info') {
            // Provide information about files
            console.log(`📊 Found ${searchResults.length} files for info query`);

            if (searchResults.length === 0) {
              console.log(`⚠️  No ${fileType || 'media'} files found`);
              await sendWhatsAppMessage(from, `❌ No ${fileType || 'media'} files found matching your request.`);
              res.status(200).send('OK');
              return;
            }

            if (intent.infoType === 'filename') {
              const file = searchResults[0];
              const messageDate = new Date(file.message_date).toLocaleDateString();
              console.log(`📎 Returning filename: ${file.file_name}`);
              await sendWhatsAppMessage(from, `📎 The file is named: "${file.file_name}"\n📅 Date: ${messageDate}`);
            } else if (intent.infoType === 'count') {
              await sendWhatsAppMessage(from, `📊 You have ${searchResults.length} ${fileType || 'media'} file(s) saved.`);
            } else if (intent.infoType === 'date') {
              const file = searchResults[0];
              const messageDate = new Date(file.message_date).toLocaleString();
              await sendWhatsAppMessage(from, `📅 The file was sent on: ${messageDate}`);
            } else {
              // Provide all info
              const file = searchResults[0];
              const messageDate = new Date(file.message_date).toLocaleString();
              await sendWhatsAppMessage(from, `📎 File: "${file.file_name}"\n📅 Date: ${messageDate}\n📦 Size: ${(file.file_size / 1024).toFixed(2)} KB\n📁 Type: ${file.file_type}`);
            }
            res.status(200).send('OK');
            return;

          } else if (intent.action === 'list') {
            // List files
            if (searchResults.length === 0) {
              await sendWhatsAppMessage(from, `❌ No ${fileType || 'media'} files found matching your request.`);
              res.status(200).send('OK');
              return;
            }

            let listMessage = `📁 Found ${searchResults.length} file(s):\n\n`;
            searchResults.slice(0, 10).forEach((file, index) => {
              const date = new Date(file.message_date).toLocaleDateString();
              listMessage += `${index + 1}. ${file.file_name} (${date})\n`;
            });

            if (searchResults.length > 10) {
              listMessage += `\n... and ${searchResults.length - 10} more files.`;
            }

            await sendWhatsAppMessage(from, listMessage);
            res.status(200).send('OK');
            return;

          } else if (intent.action === 'retrieve') {
            // Send the files back
            console.log(`📤 Retrieving files to send back. Found ${searchResults.length} files`);

            if (searchResults.length === 0) {
              console.log(`⚠️  No ${fileType || 'media'} files found for retrieval`);
              await sendWhatsAppMessage(from, `❌ No ${fileType || 'media'} files found matching your request.`);
              res.status(200).send('OK');
              return;
            }

            const fs = require('fs');
            const path = require('path');

            await sendWhatsAppMessage(from, `📁 Found ${searchResults.length} file(s). Sending now...`);

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
                    body: `📎 ${file.file_name} (${messageDate})`,
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

            res.status(200).send('OK');
            return;
          }
        }
      } catch (queryError) {
        console.error('Error in file query system:', queryError);
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

          // Map message type to folder name
          const mediaTypeFolders = {
            'image': 'images',
            'audio': 'audio',
            'video': 'videos',
            'document': 'documents'
          };

          const mediaTypeFolder = mediaTypeFolders[messageType] || 'other';
          const userMediaDir = path.join(__dirname, 'media', userPhone, mediaTypeFolder);

          // Create directory structure: media/{phone_number}/{media_type}/
          if (!fs.existsSync(userMediaDir)) {
            fs.mkdirSync(userMediaDir, { recursive: true });
            console.log(`📁 Created directory: ${userMediaDir}`);
          }

          // Generate intelligent filename based on content
          const now = new Date();
          const dateStr = now.toISOString().split('T')[0]; // Format: YYYY-MM-DD
          const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // Format: HH-MM-SS
          const extension = mediaType.split('/')[1]?.split(';')[0] || 'bin';
          let descriptiveName = 'file';
          let fileDescription = null;

          try {
            if (messageType === 'image' && imageData) {
              // Use GPT-4o vision to generate both filename and description
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

              // Generate detailed description for semantic search
              const descCompletion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Describe what you see in this image in 1-2 sentences. Include any visible text, objects, people, or important details.' },
                    { type: 'image_url', image_url: { url: imageData } }
                  ]
                }],
                max_tokens: 100
              });
              fileDescription = descCompletion.choices[0].message.content.trim();
              console.log(`✅ Generated image description: ${fileDescription}`);
            } else if (messageType === 'audio' && transcribedText) {
              // Use transcription to generate descriptive name and description
              console.log(`🎙️ Generating intelligent name for audio. Transcription: "${transcribedText.substring(0, 100)}..."`);
              const summaryCompletion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                  role: 'user',
                  content: `Create a short filename (2-4 words max, lowercase, hyphens only, no quotes) that describes what this audio is about:

"${transcribedText}"

Examples:
"I need to schedule a meeting for next week" -> "schedule-meeting"
"Here's the invoice for March 2024" -> "march-invoice"
"Reminder to buy groceries" -> "grocery-reminder"
"Discussion about the project timeline" -> "project-timeline"

Now create a filename for the audio above (2-4 words, lowercase, hyphens, no other text):`
                }],
                max_tokens: 15,
                temperature: 0.3
              });
              descriptiveName = summaryCompletion.choices[0].message.content.trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
                .replace(/-+/g, '-')
                .substring(0, 50);
              console.log(`✅ Generated audio filename: ${descriptiveName}`);

              // Use transcription as the description for semantic search
              fileDescription = transcribedText.substring(0, 500); // Limit to 500 chars
              console.log(`✅ Using transcription as audio description`);
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
            fileDescription: fileDescription,
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
    // Only for text-only messages requesting GENERATION (not retrieval or when sending files)
    const needsChart = !hasMediaAttached && /\b(chart|graph|visualize|plot)\b/i.test(incomingMsg);
    const needsImage = !hasMediaAttached && /\b(generate|create|draw|make).*\b(image|picture|diagram)\b/i.test(incomingMsg);

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
    const systemPrompt = `You are an intelligent WhatsApp assistant with deep contextual understanding. You analyze what users say, understand their intent regardless of wording, and provide helpful responses.${userTitle ? `\n\nIMPORTANT: You are speaking with ${userTitle}. Always address them respectfully using this title.` : ''}${forwardedContext}

## CORE PRINCIPLES:
1. **Understand Intent**: Interpret what the user MEANS, not just what they literally say
2. **Be Proactive**: When you receive files, automatically save them - don't ask what to do
3. **Use Context**: Remember conversation history and user patterns
4. **Confirm When Unsure**: If genuinely uncertain about user's intent, ask for clarification
5. **Learn**: Each interaction helps you understand the user better

## WHEN USER SENDS FILES:

**Your behavior when receiving media (images, audio, documents, videos):**

1. **ANALYZE** what the file shows/contains
2. **CONFIRM** receipt and what you understood from it
3. **DON'T ASK** what to do - the file is AUTOMATICALLY saved with an intelligent name

**Examples of CORRECT responses:**

User: [sends image of cedula/ID card with caption "Agrega esta imagen como cedula Max Mejia"]
You: "✅ Cédula guardada, Sr. Max! Esta es su cédula de identidad - número 402-2873981-5. La imagen se guardó automáticamente con un nombre inteligente y la puedo recuperar cuando la necesite."

User: [sends audio about meeting]
You: "✅ Audio guardado! Transcribí: '[transcription]'. Se guardó con un nombre basado en el contenido."

User: [sends invoice photo]
You: "✅ Factura guardada! Veo que es de [details from image]. Guardada automáticamente para cuando la necesite."

**WRONG responses (NEVER do this):**
- "¿Quieres que guarde esta imagen?" (Don't ask - just save)
- "¿Cómo debo nombrar este archivo?" (It's automatically named intelligently)
- "Agrega esta imagen como..." (Don't repeat their caption as a command)

## WHEN USER REQUESTS FILES:

When users ask for files back, the **AUTOMATIC FILE RETRIEVAL SYSTEM** handles it.

**How it works:**
- User says: "Send me my cedula" or "Mandame la foto de mi cedula"
- System AUTOMATICALLY searches by description/content (semantic search)
- System sends the file back
- You should ONLY acknowledge if needed, NOT say "here's your file" when you didn't send it

**Examples:**

User: "Mandame una foto de mi cedula"
System: [Automatically searches for cedula images and sends them]
You: [The system already sent it, so you can be brief] "Enviada! ✅"

OR if you're unsure what they mean:
You: "Busco tu cédula..." [then system sends it]

**NEVER say:**
- "No puedo enviar archivos" (YES YOU CAN via the automatic system)
- "Aquí está tu archivo" [without the system actually sending it]
- "No image files found" [when you haven't even searched yet]

## UNDERSTANDING INTENT:

**Be smart about what users mean:**

"Mandame una foto de mi cedula" = They want you to SEND their previously saved cedula image
"Agrega esta [image]" = They're sending you an image to SAVE (it saves automatically)
"Como se llama el audio?" = They want the FILENAME of the audio
"Enviame la imagen que te habia enviado" = They want a PREVIOUSLY SENT image back

**If unsure:**
- Ask ONE clarifying question
- Examples: "¿Te refieres a la imagen que enviaste hoy o alguna anterior?" or "¿Buscas tu cédula o algún otro documento?"

## CONVERSATION MEMORY:
You have FULL ACCESS to this conversation history. Use it to understand context.

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
      // For image generation requests without DALL-E setup
      sentMessageContent = aiResponse;
      await sendWhatsAppMessage(from, aiResponse);
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

