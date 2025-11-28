require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const { generateChart } = require('./utils/chartGenerator');
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

// Webhook endpoint for incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const from = req.body.From;
    const messageId = req.body.MessageSid;

    console.log(`Received message from ${from}: ${incomingMsg}`);

    // Ignore messages from the bot itself (sandbox number)
    if (from === process.env.TWILIO_WHATSAPP_NUMBER) {
      console.log('Ignoring message from bot itself');
      res.status(200).send('OK');
      return;
    }

    // Get or initialize conversation history
    if (!conversationHistory.has(from)) {
      conversationHistory.set(from, []);
    }
    const history = conversationHistory.get(from);

    // Add user message to history (only if content exists)
    if (incomingMsg && incomingMsg.trim()) {
      history.push({
        role: 'user',
        content: incomingMsg
      });
    }

    // Keep only last 10 messages to manage token usage
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // Determine if request needs visual output
    const needsChart = /table|chart|graph|data|visualize|show.*data/i.test(incomingMsg);
    const needsImage = /image|picture|draw|show.*visual|diagram/i.test(incomingMsg);

    // Build conversation context for OpenAI
    const systemPrompt = `You are a helpful WhatsApp assistant. You provide friendly, informative responses to questions and help with various tasks.

Be conversational, helpful, and concise. Keep responses brief and easy to read on mobile devices.`;

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

    // Get AI response from OpenAI with retry logic
    let aiResponse;
    const maxRetries = 3;
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= maxRetries) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini', // Cost-effective model
          messages: messages,
          max_tokens: 1000,
          temperature: 0.7
        });

        aiResponse = completion.choices[0].message.content;
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

    // Check if response contains chart data
    let chartData = null;
    try {
      if (aiResponse.includes('"type":"chart"') || aiResponse.includes('"type": "chart"')) {
        chartData = JSON.parse(aiResponse.match(/\{[\s\S]*\}/)[0]);
      }
    } catch (e) {
      // Not JSON, treat as regular text
    }

    // Send response
    if (chartData && needsChart) {
      // Generate and send chart image
      const chartBuffer = await generateChart(chartData);

      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: chartData.message || 'Here\'s your data visualization:',
        mediaUrl: [`data:image/png;base64,${chartBuffer.toString('base64')}`]
      });
    } else if (needsImage && !chartData) {
      // For image requests, inform about limitation
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: aiResponse + '\n\n(Note: Image generation requires DALL-E integration. Currently showing text response.)'
      });
    } else {
      // Send regular text response
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: aiResponse
      });
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).send('Error processing message');
  }
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

