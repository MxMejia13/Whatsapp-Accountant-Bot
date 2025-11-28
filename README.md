# WhatsApp Accountant Bot 🤖💰

An intelligent WhatsApp bot powered by **Google Gemini AI** and **Twilio** that provides accountant assistance, data visualization, and responds to queries with text, charts, and images.

## Features

- **Intelligent Conversations**: Powered by Google Gemini Pro for natural language understanding
- **Data Visualization**: Automatically generates charts (bar, line, pie) when you ask for data
- **Group Chat Support**: Can be added to WhatsApp groups and respond to all messages
- **Context-Aware**: Maintains conversation history for better responses
- **Financial Assistance**: Specialized in accounting, expense tracking, and financial queries
- **FREE AI**: Uses Google Gemini which has a generous free tier!

---

## Complete Setup Guide (Start to Finish)

### Step 1: Prerequisites

Before starting, make sure you have:
- **Node.js** installed (v16 or higher) - [Download here](https://nodejs.org)
- **A Twilio account** (free tier available) - [Sign up here](https://www.twilio.com/try-twilio)
- **Google account** for Gemini API (free) - You already have this!

---

### Step 2: Clone the Repository

```bash
git clone https://github.com/MxMejia13/Whatsapp-Accountant-Bot.git
cd Whatsapp-Accountant-Bot
```

---

### Step 3: Install Dependencies

```bash
npm install
```

This installs:
- Express (web server)
- Twilio SDK (WhatsApp integration)
- Google Generative AI (Gemini)
- Chart.js (data visualization)
- Other utilities

---

### Step 4: Get Your Google Gemini API Key (FREE!)

1. **Go to Google AI Studio**: https://makersuite.google.com/app/apikey
2. **Click "Get API Key"** or "Create API Key"
3. **Create a new API key** (or use existing one)
4. **Copy the API key** - You'll need this in Step 6

**Note**: Gemini offers a generous free tier:
- 60 requests per minute
- Completely free for most use cases!

---

### Step 5: Set Up Twilio WhatsApp

#### 5.1: Create Twilio Account
1. Go to: https://www.twilio.com/try-twilio
2. Sign up for a free account
3. Verify your email and phone number

#### 5.2: Join WhatsApp Sandbox
1. In Twilio Console, go to **Messaging** → **Try it out** → **Send a WhatsApp message**
2. You'll see a sandbox number like: `+1 415 523 8886`
3. You'll see a code like: `join <word>-<word>`
4. **On your phone**: Send that code to the sandbox number via WhatsApp
5. You'll receive a confirmation message

#### 5.3: Get Your Twilio Credentials
1. Go to Twilio Console Dashboard: https://console.twilio.com
2. Find your **Account SID** and **Auth Token**
3. Copy both - you'll need them in Step 6

---

### Step 6: Configure Environment Variables

1. **Copy the example environment file**:
   ```bash
   cp .env.example .env
   ```

2. **Edit the `.env` file** (use any text editor):
   ```bash
   nano .env
   # or
   code .env
   # or open in any text editor
   ```

3. **Fill in your credentials**:
   ```env
   PORT=3000

   # Twilio Credentials (from Step 5.3)
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token_here
   TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

   # Google Gemini API Key (from Step 4)
   GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. **Save the file**

---

### Step 7: Install ngrok (to expose your local server)

#### On Mac:
```bash
brew install ngrok
```

#### On Windows:
1. Download from: https://ngrok.com/download
2. Extract and add to PATH

#### On Linux:
```bash
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok
```

---

### Step 8: Start Your Bot

1. **Start the server**:
   ```bash
   npm start
   ```

   You should see:
   ```
   Server is running on port 3000
   Webhook URL: http://localhost:3000/webhook
   ```

2. **In a NEW terminal window**, start ngrok:
   ```bash
   ngrok http 3000
   ```

   You'll see output like:
   ```
   Forwarding    https://abc123def456.ngrok.io -> http://localhost:3000
   ```

3. **Copy the HTTPS URL** (e.g., `https://abc123def456.ngrok.io`)

---

### Step 9: Configure Twilio Webhook

1. Go to Twilio Console: https://console.twilio.com
2. Navigate to: **Messaging** → **Settings** → **WhatsApp Sandbox Settings**
3. Under **"When a message comes in"**:
   - Paste your ngrok URL + `/webhook`
   - Example: `https://abc123def456.ngrok.io/webhook`
4. Set the method to **POST**
5. **Save** the settings

---

### Step 10: Test Your Bot!

1. **Open WhatsApp** on your phone
2. **Send a message** to your Twilio sandbox number
3. **Try these examples**:

**Basic conversation:**
```
You: Hello!
Bot: Hi! I'm your WhatsApp accountant bot. How can I help you today?
```

**Financial question:**
```
You: What's the difference between FIFO and LIFO?
Bot: [Detailed explanation about inventory accounting methods]
```

**Request a chart:**
```
You: Show me a chart of my monthly expenses: Jan $500, Feb $750, Mar $600, Apr $800
Bot: [Sends a beautiful bar chart image]
```

**Request a pie chart:**
```
You: Create a pie chart showing budget: Rent 40%, Food 25%, Transport 15%, Savings 20%
Bot: [Sends a pie chart visualization]
```

**Financial calculation:**
```
You: If I invest $1000 monthly at 7% annual return for 5 years, what will I have?
Bot: [Calculates compound interest and explains]
```

---

## Using in WhatsApp Groups

1. **Create a WhatsApp group** (or use existing one)
2. **Add the Twilio number** to the group
3. The bot will **respond to all messages** in the group
4. Great for team financial discussions!

---

## Project Structure

```
Whatsapp-Accountant-Bot/
├── index.js                 # Main server file
├── utils/
│   ├── chartGenerator.js    # Chart generation logic
│   └── imageGenerator.js    # Image generation utilities
├── package.json             # Dependencies
├── .env                     # Your credentials (DO NOT COMMIT)
├── .env.example             # Template
├── .gitignore               # Protects sensitive files
└── README.md                # This file
```

---

## API Endpoints

Your bot exposes these endpoints:

- `GET /` - Health check (visit http://localhost:3000)
- `GET /status` - Bot status and active conversations count
- `POST /webhook` - Twilio webhook endpoint (receives WhatsApp messages)

---

## Chart Types Supported

The bot can automatically generate:

- **Bar charts** - For comparing values (monthly expenses, revenue, etc.)
- **Line charts** - For trends over time
- **Pie charts** - For proportions and percentages (budget allocation)

Just ask naturally! Examples:
- "Show me a bar chart of..."
- "Create a pie chart with..."
- "Visualize this data as a graph..."

---

## Customization

### Change Bot Personality

Edit `index.js` line 59 to customize the bot's behavior:

```javascript
const systemPrompt = `You are a helpful WhatsApp accountant bot...`
```

### Adjust Conversation Memory

Change how many messages the bot remembers in `index.js` line 51:

```javascript
if (history.length > 20) {  // Change 20 to your preference
```

---

## Troubleshooting

### Bot not responding?

**Check 1**: Is the server running?
```bash
# You should see "Server is running on port 3000"
```

**Check 2**: Is ngrok running?
```bash
# Open http://127.0.0.1:4040 to see ngrok status
```

**Check 3**: Is the webhook URL correct in Twilio?
- Should be: `https://your-ngrok-url.ngrok.io/webhook`
- Must use HTTPS (not HTTP)

**Check 4**: Are environment variables set?
```bash
# Check your .env file has all values filled in
cat .env
```

**Check 5**: Did you join the Twilio sandbox?
- Send the join code to the Twilio number first

### Server crashes?

Check the error message. Common issues:
- Missing environment variables → Check `.env` file
- Port already in use → Change PORT in `.env`
- Invalid API key → Verify your Gemini API key

### Charts not generating?

- Make sure you explicitly ask for a chart/graph/visualization
- Check server logs for errors
- Ensure `chartjs-node-canvas` installed correctly

---

## Cost Breakdown

**FREE Tier:**
- **Google Gemini**: FREE (60 requests/min, 1500 requests/day)
- **Twilio Sandbox**: FREE for testing
- **ngrok**: FREE tier works perfectly

**Production Costs:**
- **Google Gemini**: FREE up to limits above
- **Twilio**: ~$0.005-0.03 per conversation
- **Server Hosting**: Free tier on Railway/Render/Heroku
- **Dedicated WhatsApp Number**: ~$1-2/month (optional)

---

## Deploying to Production

### Option 1: Railway (Easiest)

1. **Create account**: https://railway.app
2. **New Project** → **Deploy from GitHub**
3. **Add environment variables**:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_WHATSAPP_NUMBER`
   - `GEMINI_API_KEY`
4. **Deploy**
5. Copy your Railway URL and update Twilio webhook

### Option 2: Render

1. **Create account**: https://render.com
2. **New** → **Web Service**
3. Connect your GitHub repository
4. **Environment**: Node
5. **Build**: `npm install`
6. **Start**: `npm start`
7. Add environment variables
8. Deploy and update Twilio webhook

### Option 3: Heroku

```bash
heroku create your-bot-name
heroku config:set TWILIO_ACCOUNT_SID=xxx
heroku config:set TWILIO_AUTH_TOKEN=xxx
heroku config:set GEMINI_API_KEY=xxx
heroku config:set TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
git push heroku main
```

Update Twilio webhook to: `https://your-bot-name.herokuapp.com/webhook`

---

## Production WhatsApp Number

For production (not sandbox):

1. In Twilio Console, request a **dedicated WhatsApp number**
2. Submit your **WhatsApp Business Profile**
3. Wait for approval (usually 1-3 days)
4. Update `TWILIO_WHATSAPP_NUMBER` in your environment

---

## Security Best Practices

- ✅ Never commit `.env` file to git
- ✅ Use environment variables for all secrets
- ✅ Enable rate limiting for production
- ✅ Validate incoming webhook requests from Twilio
- ✅ Use HTTPS in production (not HTTP)
- ✅ Regularly rotate API keys

---

## Why Google Gemini?

We chose Gemini for this project because:

1. **FREE**: Generous free tier (60 req/min)
2. **Powerful**: Similar quality to GPT-4
3. **Fast**: Quick response times
4. **Multimodal**: Can handle text and images
5. **No credit card**: Free tier doesn't require payment info
6. **Good for production**: Reliable and scalable

---

## FAQ

**Q: Can I use this with my personal WhatsApp number?**
A: No, you need a separate number through Twilio.

**Q: Will my WhatsApp account get banned?**
A: No, this uses the official Twilio WhatsApp Business API.

**Q: How many messages can I send?**
A: Gemini free tier allows 60 requests/minute, which is plenty for most use cases.

**Q: Can I add multiple users?**
A: Yes! The bot handles multiple conversations simultaneously.

**Q: Does it work in group chats?**
A: Yes! Just add the Twilio number to any WhatsApp group.

**Q: Can I customize the responses?**
A: Yes, edit the system prompt in `index.js`

---

## Next Steps

1. ✅ Set up the bot (you're done!)
2. Test with different queries
3. Customize the bot personality
4. Deploy to production
5. Add to your WhatsApp groups
6. Share with your team!

---

## Support

Having issues?

1. Check the **Troubleshooting** section above
2. Review your environment variables
3. Check server logs for errors
4. Open an issue on GitHub

---

## License

ISC

---

**Built with ❤️ using Google Gemini, Twilio, and Node.js**

Happy chatting! 🎉
