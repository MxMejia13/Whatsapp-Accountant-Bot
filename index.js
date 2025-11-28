require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateChart } = require('./utils/chartGenerator');
const { generateImage } = require('./utils/imageGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Initialize Google Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'models/gemini-1.5-flash-latest'
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

    // Get or initialize conversation history
    if (!conversationHistory.has(from)) {
      conversationHistory.set(from, []);
    }
    const history = conversationHistory.get(from);

    // Add user message to history
    history.push({
      role: 'user',
      content: incomingMsg
    });

    // Keep only last 10 messages to manage token usage
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // Determine if request needs visual output
    const needsChart = /table|chart|graph|data|visualize|show.*data/i.test(incomingMsg);
    const needsImage = /image|picture|draw|show.*visual|diagram/i.test(incomingMsg);

    // Build conversation context for Gemini
    const systemPrompt = `You are a helpful WhatsApp accountant bot. You assist with financial queries, calculations, expense tracking, and data analysis.

If the user asks for data in a table or chart format, structure your response as JSON with the following format:
{
  "type": "chart",
  "chartType": "bar|line|pie",
  "title": "Chart Title",
  "data": {
    "labels": ["Label1", "Label2"],
    "values": [100, 200]
  },
  "message": "Brief explanation"
}

For regular responses, just provide helpful text answers. Be concise and professional.`;

    // Format conversation history for Gemini
    let conversationContext = systemPrompt + '\n\n';
    history.forEach(msg => {
      conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
    });

    // Get AI response from Gemini
    const result = await model.generateContent(conversationContext);
    const response = await result.response;
    const aiResponse = response.text();

    // Add AI response to history
    history.push({
      role: 'assistant',
      content: aiResponse
    });

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

