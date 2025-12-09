/**
 * Media Processor Service
 *
 * Intelligent media handling that runs BEFORE the main Agent
 * Implements:
 * - Audio Heuristic (Direct voice vs Forwarded audio)
 * - Vision Analysis (OCR, document type detection)
 * - Smart Save (Auto-save if confident, ask if unsure)
 */

const OpenAI = require('openai');
const { uploadFile } = require('./CloudStorage');
const { saveMediaFile, PendingConfirmation } = require('../database/mongodb');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Confidence threshold for auto-save (0-100%)
const AUTO_SAVE_CONFIDENCE = 80;

/**
 * Process media BEFORE passing to main Agent
 * Returns processed result with instructions for Agent
 */
async function processMedia(options) {
  const {
    mediaBuffer,
    mimeType,
    originalName,
    userId,
    userTitle,
    userMessage,
    isForwarded
  } = options;

  console.log(`\n🎬 MediaProcessor: Processing ${mimeType} (Forwarded: ${isForwarded})`);

  // =========================================================================
  // AUDIO HEURISTIC: Critical Decision Point
  // =========================================================================

  if (mimeType?.startsWith('audio/')) {
    return await processAudio({
      mediaBuffer,
      mimeType,
      originalName,
      userId,
      userTitle,
      userMessage,
      isForwarded
    });
  }

  // =========================================================================
  // IMAGE/DOCUMENT: Vision Analysis
  // =========================================================================

  if (mimeType?.startsWith('image/')) {
    return await processImage({
      mediaBuffer,
      mimeType,
      originalName,
      userId,
      userTitle,
      userMessage,
      isForwarded
    });
  }

  // =========================================================================
  // OTHER FILE TYPES: Generic handling
  // =========================================================================

  return await processDocument({
    mediaBuffer,
    mimeType,
    originalName,
    userId,
    userTitle,
    userMessage,
    isForwarded
  });
}

/**
 * Audio Processing with Forwarded Heuristic
 */
async function processAudio(options) {
  const {
    mediaBuffer,
    mimeType,
    originalName,
    userId,
    userTitle,
    userMessage,
    isForwarded
  } = options;

  console.log(`🎙️  Audio Heuristic: ${isForwarded ? 'FORWARDED' : 'DIRECT'}`);

  // Transcribe with Whisper
  const { toFile } = require('openai/uploads');
  const audioFile = await toFile(mediaBuffer, 'audio.ogg', { type: mimeType });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'es'
  });

  const transcribedText = transcription.text;
  console.log(`✅ Transcribed: "${transcribedText.substring(0, 100)}..."`);

  // =========================================================================
  // SCENARIO A: Direct Voice Note (NOT Forwarded)
  // User is TALKING to the bot - DO NOT SAVE
  // =========================================================================

  if (!isForwarded) {
    console.log(`💬 Direct voice message - treating as chat`);
    return {
      action: 'CHAT',
      transcribedText: transcribedText,
      message: `[User sent voice message]: ${transcribedText}`
    };
  }

  // =========================================================================
  // SCENARIO B: Forwarded Audio
  // User is SAVING a recording - SAVE IT
  // =========================================================================

  console.log(`💾 Forwarded audio - saving as file`);

  // Generate intelligent filename from transcription
  const filenameSuggestion = await generateAudioFilename(transcribedText);

  // Check confidence
  const confidence = 85; // Audio files are generally straightforward

  if (confidence >= AUTO_SAVE_CONFIDENCE) {
    // AUTO-SAVE
    const savedFile = await saveAudioFile({
      mediaBuffer,
      mimeType,
      originalName,
      userId,
      userTitle,
      transcribedText,
      filenameSuggestion,
      confidence
    });

    return {
      action: 'SAVED',
      savedFile: savedFile,
      message: `✅ Audio guardado como "${savedFile.filename}". Transcripción: "${transcribedText.substring(0, 150)}..."`
    };
  } else {
    // ASK USER
    const pending = await createPendingConfirmation({
      userId,
      mediaBuffer,
      mimeType,
      suggestedFilename: filenameSuggestion,
      detectedText: transcribedText,
      confidence,
      documentType: 'audio',
      userMessage,
      isForwarded
    });

    return {
      action: 'ASK',
      pending: pending,
      message: `🎙️ Recibí un audio. Parece ser sobre "${filenameSuggestion}". ¿Cómo quieres que lo guarde? (o responde "no guardar" para descartar)`
    };
  }
}

/**
 * Image Processing with Vision Analysis
 */
async function processImage(options) {
  const {
    mediaBuffer,
    mimeType,
    originalName,
    userId,
    userTitle,
    userMessage,
    isForwarded
  } = options;

  console.log(`👁️  Vision Analysis starting...`);

  // Analyze with GPT-4o Vision
  const base64Image = mediaBuffer.toString('base64');
  const visionResponse = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Analyze this image in detail. You are a document analysis AI.

TASK:
1. Identify the document type (passport, ID card, receipt, invoice, contract, photo, etc.)
2. Extract ALL visible text (OCR)
3. Generate a descriptive filename (3-5 words, lowercase, hyphens only)
4. Generate 5-10 search keywords
5. Write a brief description
6. Rate your confidence (0-100%) about what this document is

FORMAT YOUR RESPONSE AS JSON:
{
  "documentType": "passport" | "id_card" | "receipt" | "invoice" | "contract" | "photo" | "screenshot" | "other",
  "filename": "passport-usa-john-doe",
  "description": "US Passport for John Doe, issued 2020",
  "keywords": ["passport", "travel", "id", "usa", "john doe"],
  "detectedText": "FULL TEXT EXTRACTED FROM IMAGE...",
  "confidence": 95
}

BE SPECIFIC. If you see "República Dominicana" and "Cédula", it's an ID card with high confidence.`
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64Image}`
          }
        }
      ]
    }],
    max_tokens: 1500,
    response_format: { type: 'json_object' }
  });

  const analysis = JSON.parse(visionResponse.choices[0].message.content);
  console.log(`✅ Vision analysis complete:`);
  console.log(`   Type: ${analysis.documentType} (${analysis.confidence}% confident)`);
  console.log(`   Filename: ${analysis.filename}`);

  // =========================================================================
  // SMART SAVE LOGIC
  // =========================================================================

  if (analysis.confidence >= AUTO_SAVE_CONFIDENCE) {
    // AUTO-SAVE (High confidence)
    console.log(`💾 High confidence (${analysis.confidence}%) - auto-saving`);

    const savedFile = await saveImageFile({
      mediaBuffer,
      mimeType,
      originalName,
      userId,
      userTitle,
      analysis,
      userMessage,
      isForwarded
    });

    return {
      action: 'SAVED',
      savedFile: savedFile,
      analysis: analysis,
      message: `✅ ${analysis.documentType === 'id_card' ? 'Cédula' : capitalizeFirst(analysis.documentType)} guardada como "${savedFile.filename}". ${analysis.description || ''}`
    };
  } else {
    // ASK USER (Low confidence)
    console.log(`❓ Low confidence (${analysis.confidence}%) - asking user`);

    const pending = await createPendingConfirmation({
      userId,
      mediaBuffer,
      mimeType,
      suggestedFilename: analysis.filename,
      suggestedDescription: analysis.description,
      suggestedKeywords: analysis.keywords,
      detectedText: analysis.detectedText,
      documentType: analysis.documentType,
      confidence: analysis.confidence,
      userMessage,
      isForwarded
    });

    return {
      action: 'ASK',
      pending: pending,
      analysis: analysis,
      message: `📷 Recibí una imagen. Parece ser ${analysis.documentType === 'other' ? 'un documento' : articuloFor(analysis.documentType)} ${analysis.documentType}, pero no estoy seguro (${analysis.confidence}% confianza). ¿Cómo quieres que lo guarde?`
    };
  }
}

/**
 * Generic Document Processing
 */
async function processDocument(options) {
  const {
    mediaBuffer,
    mimeType,
    originalName,
    userId,
    userTitle,
    userMessage,
    isForwarded
  } = options;

  console.log(`📄 Document processing: ${mimeType}`);

  // For PDFs and other documents, we can't analyze content easily
  // So we ask the user
  const pending = await createPendingConfirmation({
    userId,
    mediaBuffer,
    mimeType,
    suggestedFilename: originalName || 'document',
    documentType: 'document',
    confidence: 50,
    userMessage,
    isForwarded
  });

  return {
    action: 'ASK',
    pending: pending,
    message: `📄 Recibí un documento (${mimeType}). ¿Cómo quieres que lo nombre?`
  };
}

/**
 * Save audio file to cloud and MongoDB
 */
async function saveAudioFile(data) {
  const { mediaBuffer, mimeType, originalName, userId, userTitle, transcribedText, filenameSuggestion, confidence } = data;

  // Upload to cloud storage
  const uploadResult = await uploadFile(mediaBuffer, {
    mimeType,
    originalName,
    userId,
    isForwarded: true
  });

  // Save metadata to MongoDB
  const mediaFile = await saveMediaFile({
    userId,
    userTitle,
    s3Url: uploadResult.url,
    s3Key: uploadResult.key,
    filename: filenameSuggestion,
    description: `Audio: ${transcribedText.substring(0, 200)}`,
    keywords: extractKeywords(transcribedText),
    detectedText: transcribedText,
    documentType: 'audio',
    confidence,
    originalName,
    mimeType,
    fileSize: uploadResult.size,
    isForwarded: true
  });

  return mediaFile;
}

/**
 * Save image file to cloud and MongoDB
 */
async function saveImageFile(data) {
  const { mediaBuffer, mimeType, originalName, userId, userTitle, analysis, userMessage, isForwarded } = data;

  // Upload to cloud storage
  const uploadResult = await uploadFile(mediaBuffer, {
    mimeType,
    originalName,
    userId,
    isForwarded
  });

  // Save metadata to MongoDB
  const mediaFile = await saveMediaFile({
    userId,
    userTitle,
    s3Url: uploadResult.url,
    s3Key: uploadResult.key,
    filename: analysis.filename,
    description: analysis.description,
    keywords: analysis.keywords,
    detectedText: analysis.detectedText,
    documentType: analysis.documentType,
    confidence: analysis.confidence,
    originalName,
    mimeType,
    fileSize: uploadResult.size,
    isForwarded
  });

  return mediaFile;
}

/**
 * Create pending confirmation (for low-confidence saves)
 */
async function createPendingConfirmation(data) {
  const pending = new PendingConfirmation(data);
  await pending.save();
  return pending;
}

/**
 * Generate intelligent filename from audio transcription
 */
async function generateAudioFilename(transcribedText) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Generate a short filename (3-5 words max, lowercase, hyphens only, no quotes) for this audio transcription:

"${transcribedText.substring(0, 300)}"

Examples:
"Necesito programar una reunión para la próxima semana" -> "reunion-proxima-semana"
"Esta es la factura de marzo del supermercado" -> "factura-marzo-supermercado"
"Recordatorio para comprar comida" -> "recordatorio-comprar-comida"

Just the filename, nothing else:`
    }],
    max_tokens: 15,
    temperature: 0.3
  });

  return completion.choices[0].message.content.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .substring(0, 50);
}

/**
 * Extract keywords from text
 */
function extractKeywords(text) {
  // Simple keyword extraction (can be improved with NLP)
  const words = text.toLowerCase()
    .replace(/[^\w\sáéíóúñü]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3);

  // Get unique words
  const unique = [...new Set(words)];

  // Return top 10
  return unique.slice(0, 10);
}

/**
 * Helper: Capitalize first letter
 */
function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Helper: Get Spanish article
 */
function articuloFor(word) {
  const femenino = ['cedula', 'factura', 'foto', 'imagen'];
  return femenino.includes(word) ? 'una' : 'un';
}

module.exports = {
  processMedia
};
