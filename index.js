require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
const axios = require('axios');
const { generateChart, generateTable } = require('./utils/chartGenerator');
const { generateImage } = require('./utils/imageGenerator');

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

// Store generated charts temporarily (chartId -> buffer)
const chartStorage = new Map();

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
    const userPhone = from.replace('whatsapp:', '');
    const isOwner = userPhone === '+18093833443';
    const userTitle = isOwner ? 'Sr. Mejia' : '';

    // Build conversation context for OpenAI
    const systemPrompt = `You are a helpful WhatsApp assistant. You provide friendly, informative responses to questions and help with various tasks.${userTitle ? `\n\nIMPORTANT: You are speaking with ${userTitle}. Always address them respectfully using this title.` : ''}

CRITICAL - CONVERSATION MEMORY:
You have FULL ACCESS to this conversation history. Every message, image analysis, and data extraction is available to you above. When users say "that data", "those numbers", "the previous data", "los datos anteriores", etc., you MUST:
1. Search through the conversation history above
2. Find the data they're referring to
3. Use that exact data in your response
NEVER say you don't have access to previous data - YOU DO HAVE IT in the conversation history!

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

CRITICAL: When extracting data from images:
- Read ALL text and numbers EXACTLY as they appear
- Maintain the exact values, don't round or approximate
- Preserve the structure and all rows/columns
- Extract EVERY cell accurately

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

      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: visualData.message || `Here's your ${isTable ? 'table' : 'chart'}:`,
        mediaUrl: [visualUrl]
      });
    } else if (needsImage && !visualData) {
      // For image requests, inform about limitation
      let message = aiResponse + '\n\n(Note: Image generation requires DALL-E integration. Currently showing text response.)';
      if (message.length > 1600) {
        message = message.substring(0, 1597) + '...';
      }
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: message
      });
    } else {
      // Send regular text response (truncate if too long for WhatsApp)
      let message = aiResponse;
      if (message.length > 1600) {
        message = message.substring(0, 1597) + '...';
      }
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: message
      });
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});

