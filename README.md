# WhatsApp Accountant Bot 🤖💰

An intelligent WhatsApp bot powered by OpenAI GPT-4 and Twilio that provides accountant assistance, data visualization, and responds to queries with text, charts, and images.

## Features

- **Intelligent Conversations**: Powered by OpenAI GPT-4 for natural language understanding
- **Data Visualization**: Automatically generates charts (bar, line, pie) when you ask for data
- **Group Chat Support**: Can be added to WhatsApp groups and respond to all messages
- **Context-Aware**: Maintains conversation history for better responses
- **Financial Assistance**: Specialized in accounting, expense tracking, and financial queries
- **Image Responses**: Can send visual content when requested

## Prerequisites

1. **Node.js** (v16 or higher)
2. **Twilio Account** with WhatsApp enabled
3. **OpenAI API Key** for GPT-4 access
4. **ngrok** or similar tool for local development (to expose your webhook)

## Setup Instructions

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd Whatsapp-Accountant-Bot
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```env
PORT=3000

# Twilio Credentials (from https://console.twilio.com)
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

# OpenAI API Key (from https://platform.openai.com/api-keys)
OPENAI_API_KEY=your_openai_api_key_here
```

### 3. Set Up Twilio WhatsApp Sandbox

1. Go to [Twilio Console](https://console.twilio.com)
2. Navigate to **Messaging** > **Try it out** > **Send a WhatsApp message**
3. Follow the instructions to join the sandbox (send a code to the sandbox number)
4. The sandbox number will be something like `whatsapp:+14155238886`

### 4. Expose Your Local Server (Development)

Use ngrok to expose your local server:

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### 5. Configure Twilio Webhook

1. In Twilio Console, go to **Messaging** > **Settings** > **WhatsApp Sandbox Settings**
2. Under "When a message comes in", paste your webhook URL:
   ```
   https://your-ngrok-url.ngrok.io/webhook
   ```
3. Set the method to **POST**
4. Save the settings

### 6. Start the Bot

```bash
npm start
```

You should see:
```
Server is running on port 3000
Webhook URL: http://localhost:3000/webhook
```

## Usage

### Basic Conversation

Just send any message to your Twilio WhatsApp number:

```
You: What's the difference between FIFO and LIFO?
Bot: [Detailed explanation about inventory accounting methods]
```

### Request Data Visualization

Ask for data in chart format:

```
You: Show me a chart of my monthly expenses: Jan $500, Feb $750, Mar $600
Bot: [Sends a bar chart image with the data]
```

```
You: Create a pie chart showing budget allocation: Rent 40%, Food 25%, Transport 15%, Savings 20%
Bot: [Sends a pie chart visualization]
```

### Financial Calculations

```
You: If I invest $1000 monthly at 7% annual return for 5 years, how much will I have?
Bot: [Calculates and explains the compound interest result]
```

### Group Chat

1. Add the bot to a WhatsApp group
2. It will respond to all messages in the group
3. Great for team financial discussions!

## API Endpoints

- `GET /` - Health check
- `GET /status` - Bot status and active conversations count
- `POST /webhook` - Twilio webhook endpoint (receives WhatsApp messages)

## Chart Types Supported

The bot can generate:
- **Bar charts** - For comparing values
- **Line charts** - For trends over time
- **Pie charts** - For proportions and percentages

## Project Structure

```
Whatsapp-Accountant-Bot/
├── index.js                 # Main server file
├── utils/
│   ├── chartGenerator.js    # Chart generation logic
│   └── imageGenerator.js    # Image generation utilities
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Customization

### Change AI Behavior

Edit the system prompt in `index.js:54` to customize the bot's personality and expertise:

```javascript
{
  role: 'system',
  content: `You are a helpful WhatsApp accountant bot...`
}
```

### Adjust Conversation History

Change the history limit in `index.js:49`:

```javascript
if (history.length > 20) {  // Keep last 20 messages
  history.splice(0, history.length - 20);
}
```

### Add Image Generation with DALL-E

The bot includes placeholder support for image generation. To enable:

1. Uncomment DALL-E integration in `index.js`
2. Use the `generateImageWithDALLE` function from `utils/imageGenerator.js`

## Production Deployment

### Option 1: Heroku

```bash
heroku create your-bot-name
heroku config:set TWILIO_ACCOUNT_SID=xxx
heroku config:set TWILIO_AUTH_TOKEN=xxx
heroku config:set OPENAI_API_KEY=xxx
heroku config:set TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
git push heroku main
```

Update Twilio webhook to: `https://your-bot-name.herokuapp.com/webhook`

### Option 2: Railway/Render/DigitalOcean

1. Connect your repository
2. Add environment variables
3. Deploy
4. Update Twilio webhook URL

### Production WhatsApp Number

For production use:

1. Request a dedicated WhatsApp number from Twilio
2. Submit for WhatsApp Business API approval
3. Update `TWILIO_WHATSAPP_NUMBER` in your environment

## Troubleshooting

**Bot not responding:**
- Check ngrok is running and URL is correct in Twilio
- Verify environment variables are set correctly
- Check server logs for errors

**Charts not generating:**
- Ensure `chartjs-node-canvas` installed correctly
- Check OpenAI response format

**"Unauthorized" errors:**
- Verify Twilio credentials are correct
- Check Account SID and Auth Token match

## Cost Considerations

- **Twilio**: Sandbox is free for testing. Production costs ~$0.005-0.03 per conversation
- **OpenAI GPT-4**: ~$0.03 per 1K input tokens, $0.06 per 1K output tokens
- **Server**: Free tier available on Heroku, Railway, Render

## Security Notes

- Never commit `.env` file
- Keep your API keys secure
- Use environment variables for all sensitive data
- Consider rate limiting for production use

## License

ISC

## Support

For issues and questions, please open an issue in the repository.

---

Built with ❤️ using Twilio, OpenAI, and Node.js