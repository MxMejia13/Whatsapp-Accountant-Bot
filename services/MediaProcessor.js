/**
 * Media Processor Service
 *
 * Intelligent media handling that runs BEFORE the main Agent
 * Implements:
 * - Audio Heuristic (Direct voice vs Forwarded audio)
 * - Vision Analysis (OCR, document type detection)
 * - Smart Save (Auto-save if confident, ask if unsure)
 * - BULLETPROOF R2 Upload Pipeline with Comprehensive Validation
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
 *
 * CRITICAL PIPELINE:
 * 1. Validate media buffer (done by caller - index.js downloads from Twilio)
 * 2. Analyze media (Vision API or Whisper)
 * 3. Upload to R2 Storage (VALIDATE SUCCESS)
 * 4. Save metadata to MongoDB (ONLY if R2 upload succeeded)
 * 5. Return result with ALL required fields or ERROR
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

  try {
    // =========================================================================
    // CRITICAL INPUT VALIDATION - PREVENT ALL CRASHES
    // =========================================================================

    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
      console.error('❌ MediaProcessor: Invalid media buffer');
      console.error('   mediaBuffer exists:', !!mediaBuffer);
      console.error('   is Buffer:', Buffer.isBuffer(mediaBuffer));
      return {
        action: 'ERROR',
        error: 'Invalid media buffer',
        message: 'Lo siento, no pude descargar el archivo multimedia. Por favor, intenta enviarlo de nuevo.'
      };
    }

    if (mediaBuffer.length === 0) {
      console.error('❌ MediaProcessor: Empty media buffer (0 bytes)');
      return {
        action: 'ERROR',
        error: 'Empty media buffer',
        message: 'Lo siento, el archivo está vacío. Por favor, intenta enviarlo de nuevo.'
      };
    }

    if (!mimeType || typeof mimeType !== 'string') {
      console.error('❌ MediaProcessor: Invalid MIME type:', mimeType);
      return {
        action: 'ERROR',
        error: 'Invalid MIME type',
        message: 'Lo siento, el tipo de archivo no es reconocido. Por favor, intenta con otro formato.'
      };
    }

    if (!userId) {
      console.error('❌ MediaProcessor: Missing userId');
      return {
        action: 'ERROR',
        error: 'Missing userId',
        message: 'Lo siento, hubo un error identificando tu cuenta. Por favor, intenta de nuevo.'
      };
    }

    console.log(`\n🎬 MediaProcessor: Processing ${mimeType}`);
    console.log(`   Buffer size: ${mediaBuffer.length} bytes`);
    console.log(`   User: ${userTitle || userId}`);
    console.log(`   Forwarded: ${isForwarded || false}`);
    console.log(`   Original name: ${originalName || 'unknown'}`);

    // =========================================================================
    // ROUTE TO APPROPRIATE PROCESSOR
    // =========================================================================

    if (mimeType.startsWith('audio/')) {
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

    if (mimeType.startsWith('image/')) {
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

    // Other file types (PDF, Word, etc.)
    return await processDocument({
      mediaBuffer,
      mimeType,
      originalName,
      userId,
      userTitle,
      userMessage,
      isForwarded
    });

  } catch (error) {
    console.error('❌ MediaProcessor: Fatal error:', error);
    console.error('   Stack:', error.stack);
    return {
      action: 'ERROR',
      error: error.message,
      message: 'Lo siento, hubo un error procesando tu archivo. Por favor, intenta de nuevo.'
    };
  }
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
    transcribedText,
    filenameSuggestion,
    userMessage,
    isForwarded
  } = options;

  try {
    // Validate buffer
    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer) || mediaBuffer.length === 0) {
      console.error('❌ processAudio: Invalid audio buffer');
      return {
        action: 'ERROR',
        error: 'Invalid audio buffer',
        message: 'Lo siento, el archivo de audio está corrupto o vacío.'
      };
    }

    console.log(`🎙️  Audio: ${isForwarded ? 'FORWARDED' : 'DIRECT'} (${mediaBuffer.length} bytes)`);

    // Transcribe with Whisper
    const { toFile } = require('openai/uploads');
    const audioFile = await toFile(mediaBuffer, 'audio.ogg', { type: mimeType });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'es'
    });

    const transcribedText = transcription.text;

    if (!transcribedText || transcribedText.trim().length === 0) {
      console.log('⚠️  Empty transcription');
      return {
        action: 'ERROR',
        error: 'Empty transcription',
        message: 'No pude transcribir el audio. Por favor, asegúrate de que tenga contenido hablado.'
      };
    }

    console.log(`✅ Transcribed: "${transcribedText.substring(0, 100)}..."`);

    // =========================================================================
    // SCENARIO A: Direct Voice Note (NOT Forwarded) - DO NOT SAVE
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
    // SCENARIO B: Forwarded Audio - SAVE IT
    // =========================================================================

    console.log(`💾 Forwarded audio - saving`);

    // Generate filename
    const filenameSuggestion = await generateAudioFilename(transcribedText);
    const confidence = 85;

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
        message: `🎙️ Recibí un audio. Parece ser sobre "${filenameSuggestion}". ¿Cómo quieres que lo guarde?`
      };
    }

  } catch (error) {
    console.error('❌ processAudio: Error:', error);
    console.error('   Stack:', error.stack);
    return {
      action: 'ERROR',
      error: error.message,
      message: 'Lo siento, hubo un error procesando el audio. Por favor, intenta de nuevo.'
    };
  }
}

/**
 * Image Processing with Vision Analysis
 * CRITICAL: This function MUST validate R2 upload before MongoDB save
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

  try {
    // =========================================================================
    // INPUT VALIDATION
    // =========================================================================

    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
      console.error('❌ processImage: Invalid buffer (null or not a Buffer)');
      return {
        action: 'ERROR',
        error: 'Invalid image buffer',
        message: 'Lo siento, no pude procesar la imagen. El archivo parece estar corrupto.'
      };
    }

    if (mediaBuffer.length === 0) {
      console.error('❌ processImage: Empty buffer (0 bytes)');
      return {
        action: 'ERROR',
        error: 'Empty image buffer',
        message: 'Lo siento, la imagen está vacía. Por favor, intenta enviarla de nuevo.'
      };
    }

    if (!mimeType || !mimeType.startsWith('image/')) {
      console.error('❌ processImage: Invalid MIME type:', mimeType);
      return {
        action: 'ERROR',
        error: 'Invalid MIME type',
        message: 'Lo siento, el archivo no parece ser una imagen válida.'
      };
    }

    console.log(`👁️  Vision Analysis: ${mimeType} (${mediaBuffer.length} bytes)`);

    // =========================================================================
    // SAFE BASE64 CONVERSION
    // =========================================================================

    let base64Image;
    try {
      base64Image = mediaBuffer.toString('base64');

      if (!base64Image || base64Image.length === 0) {
        throw new Error('Base64 conversion resulted in empty string');
      }
    } catch (conversionError) {
      console.error('❌ processImage: Base64 conversion failed:', conversionError);
      return {
        action: 'ERROR',
        error: 'Base64 conversion failed',
        message: 'Lo siento, no pude procesar la imagen. Por favor, intenta de nuevo.'
      };
    }

    // =========================================================================
    // VISION API CALL WITH FALLBACK
    // =========================================================================

    let analysis;
    try {
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

      if (!visionResponse?.choices?.[0]?.message?.content) {
        throw new Error('Vision API returned empty response');
      }

      analysis = JSON.parse(visionResponse.choices[0].message.content);

      // Validate required fields
      if (!analysis.documentType || !analysis.filename) {
        throw new Error('Vision analysis missing required fields');
      }

      // Ensure defaults for optional fields
      analysis.keywords = analysis.keywords || [];
      analysis.detectedText = analysis.detectedText || '';
      analysis.description = analysis.description || '';
      analysis.confidence = analysis.confidence || 50;

    } catch (visionError) {
      console.error('❌ processImage: Vision API error:', visionError);

      // Fallback: Ask user
      const pending = await createPendingConfirmation({
        userId,
        mediaBuffer,
        mimeType,
        suggestedFilename: originalName || 'image',
        documentType: 'photo',
        confidence: 0,
        userMessage,
        isForwarded
      });

      return {
        action: 'ASK',
        pending: pending,
        message: `📷 Recibí una imagen pero no pude analizarla automáticamente. ¿Cómo quieres que la guarde?`
      };
    }

    console.log(`✅ Vision: ${analysis.documentType} (${analysis.confidence}% confidence)`);
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
        message: `✅ ${analysis.documentType === 'id_card' ? 'Cédula' : capitalizeFirst(analysis.documentType)} guardada como "${savedFile.filename}".`
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
        message: `📷 Recibí una imagen. Parece ser ${articuloFor(analysis.documentType)} ${analysis.documentType}, pero no estoy seguro (${analysis.confidence}% confianza). ¿Cómo quieres que lo guarde?`
      };
    }

  } catch (error) {
    console.error('❌ processImage: Fatal error:', error);
    console.error('   Stack:', error.stack);
    return {
      action: 'ERROR',
      error: error.message,
      message: 'Lo siento, hubo un error grave procesando la imagen. Por favor, intenta de nuevo.'
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

  try {
    // Validate buffer
    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer) || mediaBuffer.length === 0) {
      console.error('❌ processDocument: Invalid buffer');
      return {
        action: 'ERROR',
        error: 'Invalid document buffer',
        message: 'Lo siento, no pude procesar el documento. Por favor, intenta enviarlo de nuevo.'
      };
    }

    console.log(`📄 Document: ${mimeType} (${mediaBuffer.length} bytes)`);

    // Ask user for filename
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

  } catch (error) {
    console.error('❌ processDocument: Error:', error);
    console.error('   Stack:', error.stack);
    return {
      action: 'ERROR',
      error: error.message,
      message: 'Lo siento, hubo un error procesando el documento. Por favor, intenta de nuevo.'
    };
  }
}

/**
 * Save audio file to R2 and MongoDB
 * CRITICAL: Upload to R2 FIRST, validate, THEN save to MongoDB
 */
async function saveAudioFile(data) {
  const { mediaBuffer, mimeType, originalName, userId, userTitle, transcribedText, filenameSuggestion, confidence } = data;

  try {
    // Validate inputs
    if (!mediaBuffer || !userId) {
      throw new Error('saveAudioFile: Missing required fields (mediaBuffer or userId)');
    }

    console.log(`💾 saveAudioFile: Starting for "${filenameSuggestion}"`);

    // =========================================================================
    // STEP 1: Upload to R2 (MUST SUCCEED FIRST)
    // =========================================================================

    console.log(`   [1/2] Uploading to R2...`);
    const uploadResult = await uploadFile(mediaBuffer, {
      mimeType,
      originalName: originalName || 'audio.ogg',
      userId,
      isForwarded: true
    });

    // CRITICAL: Validate upload result BEFORE proceeding
    if (!uploadResult) {
      throw new Error('R2 upload returned null/undefined');
    }

    if (!uploadResult.url) {
      throw new Error('R2 upload missing url field');
    }

    if (!uploadResult.key) {
      throw new Error('R2 upload missing key field');
    }

    console.log(`   ✅ R2 upload complete`);
    console.log(`      URL: ${uploadResult.url}`);
    console.log(`      Key: ${uploadResult.key}`);

    // =========================================================================
    // STEP 2: Save metadata to MongoDB (AFTER R2 upload)
    // =========================================================================

    console.log(`   [2/2] Saving to MongoDB...`);
    const mediaFile = await saveMediaFile({
      userId,
      userTitle,
      s3Url: uploadResult.url,       // ← REQUIRED from R2
      s3Key: uploadResult.key,        // ← REQUIRED from R2
      filename: filenameSuggestion,   // ← REQUIRED
      description: `Audio: ${transcribedText.substring(0, 200)}`,
      keywords: extractKeywords(transcribedText),
      detectedText: transcribedText,
      documentType: 'audio',
      confidence,
      originalName: originalName || 'audio.ogg',
      mimeType,                       // ← REQUIRED
      fileSize: uploadResult.size,
      isForwarded: true
    });

    console.log(`   ✅ MongoDB save complete: ${mediaFile._id}`);

    return mediaFile;

  } catch (error) {
    console.error('❌ saveAudioFile: Error:', error);
    console.error('   Stack:', error.stack);
    throw error; // Re-throw to be caught by caller
  }
}

/**
 * Save image file to R2 and MongoDB
 * CRITICAL: Upload to R2 FIRST, validate, THEN save to MongoDB
 */
async function saveImageFile(data) {
  const { mediaBuffer, mimeType, originalName, userId, userTitle, analysis, userMessage, isForwarded } = data;

  try {
    // Validate inputs
    if (!mediaBuffer) {
      throw new Error('saveImageFile: Missing mediaBuffer');
    }

    if (!userId) {
      throw new Error('saveImageFile: Missing userId');
    }

    if (!analysis || !analysis.filename) {
      throw new Error('saveImageFile: Missing or invalid analysis object');
    }

    console.log(`💾 saveImageFile: Starting for "${analysis.filename}"`);

    // =========================================================================
    // STEP 1: Upload to R2 (MUST SUCCEED FIRST)
    // =========================================================================

    console.log(`   [1/2] Uploading to R2...`);
    const uploadResult = await uploadFile(mediaBuffer, {
      mimeType,
      originalName: originalName || 'image.jpg',
      userId,
      isForwarded: isForwarded || false
    });

    // CRITICAL: Validate upload result BEFORE proceeding
    if (!uploadResult) {
      throw new Error('R2 upload returned null/undefined');
    }

    if (!uploadResult.url) {
      throw new Error('R2 upload missing url field');
    }

    if (!uploadResult.key) {
      throw new Error('R2 upload missing key field');
    }

    console.log(`   ✅ R2 upload complete`);
    console.log(`      URL: ${uploadResult.url}`);
    console.log(`      Key: ${uploadResult.key}`);

    // =========================================================================
    // STEP 2: Save metadata to MongoDB (AFTER R2 upload)
    // =========================================================================

    console.log(`   [2/2] Saving to MongoDB...`);
    const mediaFile = await saveMediaFile({
      userId,
      userTitle,
      s3Url: uploadResult.url,       // ← REQUIRED from R2
      s3Key: uploadResult.key,        // ← REQUIRED from R2
      filename: analysis.filename,    // ← REQUIRED
      description: analysis.description || '',
      keywords: analysis.keywords || [],
      detectedText: analysis.detectedText || '',
      documentType: analysis.documentType || 'photo',
      confidence: analysis.confidence || 0,
      originalName: originalName || 'image.jpg',
      mimeType,                       // ← REQUIRED
      fileSize: uploadResult.size,
      isForwarded: isForwarded || false
    });

    console.log(`   ✅ MongoDB save complete: ${mediaFile._id}`);

    return mediaFile;

  } catch (error) {
    console.error('❌ saveImageFile: Error:', error);
    console.error('   Stack:', error.stack);
    throw error; // Re-throw to be caught by caller
  }
}

/**
 * Create pending confirmation (for low-confidence saves)
 */
async function createPendingConfirmation(data) {
  try {
    const pending = new PendingConfirmation(data);
    await pending.save();
    console.log(`💾 Pending confirmation created: ${pending._id}`);
    return pending;
  } catch (error) {
    console.error('❌ createPendingConfirmation: Error:', error);
    console.error('   Stack:', error.stack);
    throw error;
  }
}

/**
 * Generate intelligent filename from audio transcription
 */
async function generateAudioFilename(transcribedText) {
  try {
    if (!transcribedText || transcribedText.trim().length === 0) {
      return 'audio-file';
    }

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

    const filename = completion.choices[0].message.content.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-')
      .substring(0, 50);

    return filename || 'audio-file';

  } catch (error) {
    console.error('❌ generateAudioFilename: Error:', error);
    return 'audio-file'; // Fallback
  }
}

/**
 * Extract keywords from text
 */
function extractKeywords(text) {
  try {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const words = text.toLowerCase()
      .replace(/[^\w\sáéíóúñü]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3);

    const unique = [...new Set(words)];

    return unique.slice(0, 10);
  } catch (error) {
    console.error('❌ extractKeywords: Error:', error);
    return [];
  }
}

/**
 * Helper: Capitalize first letter
 */
function capitalizeFirst(str) {
  if (!str || typeof str !== 'string') return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Helper: Get Spanish article
 */
function articuloFor(word) {
  if (!word || typeof word !== 'string') return 'un';
  const femenino = ['cedula', 'factura', 'foto', 'imagen', 'id_card'];
  return femenino.includes(word.toLowerCase()) ? 'una' : 'un';
}

module.exports = {
  processMedia
};
