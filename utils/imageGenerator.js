const sharp = require('sharp');

/**
 * Generate a simple image (placeholder for DALL-E integration)
 * @param {string} prompt - Image generation prompt
 * @returns {Buffer} Image buffer
 */
async function generateImage(prompt) {
  // This is a placeholder. To use actual image generation:
  // 1. Use OpenAI's DALL-E API
  // 2. Or use Stable Diffusion
  // 3. Or other image generation services

  // For now, create a simple placeholder image
  const svg = `
    <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="600" fill="#f0f0f0"/>
      <text x="400" y="300" font-size="24" text-anchor="middle" fill="#333">
        Image generation requires DALL-E API
      </text>
      <text x="400" y="340" font-size="16" text-anchor="middle" fill="#666">
        Prompt: ${prompt.substring(0, 50)}...
      </text>
    </svg>
  `;

  return await sharp(Buffer.from(svg))
    .png()
    .toBuffer();
}

/**
 * Generate image using OpenAI DALL-E (when API key is configured)
 * @param {Object} openai - OpenAI client instance
 * @param {string} prompt - Image generation prompt
 * @returns {string} Image URL
 */
async function generateImageWithDALLE(openai, prompt) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
    });

    return response.data[0].url;
  } catch (error) {
    console.error('Error generating image with DALL-E:', error);
    throw error;
  }
}

module.exports = {
  generateImage,
  generateImageWithDALLE
};
