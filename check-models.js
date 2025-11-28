require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modelsToTest = [
  'gemini-pro',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.0-pro',
  'models/gemini-pro',
  'models/gemini-1.5-pro',
  'models/gemini-1.5-flash'
];

async function testModels() {
  console.log('Testing which models work with your API key...\n');

  for (const modelName of modelsToTest) {
    try {
      console.log(`Testing: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent('Hello');
      const response = await result.response;
      const text = response.text();
      console.log(`✅ SUCCESS: ${modelName} works!`);
      console.log(`   Response: ${text.substring(0, 50)}...\n`);
    } catch (error) {
      console.log(`❌ FAILED: ${modelName}`);
      console.log(`   Error: ${error.message}`);
      console.log(`   Status: ${error.status}\n`);
    }
  }
}

testModels();
