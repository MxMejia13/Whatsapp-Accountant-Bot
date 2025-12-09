/**
 * Media Processor Service
 *
 * Intelligent media handling that runs BEFORE the main Agent
 * Implements:
 * - Audio Heuristic (Direct voice vs Forwarded audio)
 * - Vision Analysis (OCR, document type detection)
 * - Smart Save (Auto-save if confident, ask if unsure)
 * - Complete R2 Upload Pipeline with Error Handling
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
 * CRITICAL: This function handles the COMPLETE pipeline:
 * 1. Download from Twilio (done by caller - index.js)
 * 2. Analyze media (Vision/Whisper)
 * 3. Upload to R2 Storage
 * 4. Save metadata to MongoDB
 * 5. Return result with all required fields
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
    // INPUT VALIDATION - CRITICAL FIRST STEP
    // =========================================================================

    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer) || mediaBuffer.length === 0) {
      console.error('❌ Invalid or empty media buffer received');
      console.error('   Buffer exists:', !!mediaBuffer);
      console.error('   Is Buffer:', Buffer.isBuffer(mediaBuffer));
      console.error('   Length:', mediaBuffer?.length || 0);
      return {
        action: 'ERROR',
        error: 'Invalid or empty media buffer',
        message: 'Lo siento, no pude descargar el archivo multimedia. Por favor, intenta enviarlo de nuevo.'
      };
    }

    if (!mimeType || typeof mimeType !== 'string') {
      console.error('❌ Invalid MIME type received:', mimeType);
      return {
        action: 'ERROR',
        error: 'Invalid MIME type',
        message: 'Lo siento, el tipo de archivo no es reconocido. Por favor, intenta con otro formato.'
      };
    }

    if (!userId) {
      console.error('❌ userId is required but was not provided');
      return {
        action: 'ERROR',
        error: 'Missing userId',
        message: 'Lo siento, hubo un error identificando tu cuenta. Por favor, intenta de nuevo.'
      };
    }

    console.log(`\n🎬 MediaProcessor: Processing ${mimeType} (${mediaBuffer.length} bytes, Forwarded: ${isForwarded})`);
    console.log(`   User: ${userTitle || userId}`);
    console.log(`   Original Name: ${originalName || 'unknown'}`);

    // =========================================================================
    // AUDIO HEURISTIC: Critical Decision Point
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

    // =========================================================================
    // IMAGE/DOCUMENT: Vision Analysis
    // =========================================================================

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

  } catch (error) {
    console.error('❌ Fatal error in processMedia:', error);
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
    userMessage,
    isForwarded
  } = options;

  try {
    // Validate buffer
    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer) || mediaBuffer.length === 0) {
      console.error('❌ Invalid audio buffer');
      return {
        action: 'ERROR',
        error: 'Invalid audio buffer',
        message: 'Lo siento, el archivo de audio está corrupto o vacío. Por favor, intenta enviarlo de nuevo.'
      };
    }

    console.log(`🎙️  Audio Heuristic: ${isForwarded ? 'FORWARDED' : 'DIRECT'} (${mediaBuffer.length} bytes)`);

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
      console.log('⚠️  Empty transcription received');
      return {
        action: 'ERROR',
        error: 'Empty transcription',
        message: 'No pude transcribir el audio. Por favor, asegúrate de que el audio tenga contenido hablado.'
      };
    }

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
      // ASK USER (low confidence - shouldn't happen for audio but kept for completeness)
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

  } catch (error) {
    console.error('❌ Error processing audio:', error);
    console.error('   Stack:', error.stack);
    return {
      action: 'ERROR',
      error: error.message,
      message: 'Lo siento, hubo un error procesando el audio. Por favor, intenta enviarlo de nuevo.'
    };
  }
}

/**
 * Image Processing with Vision Analysis
 * CRITICAL: This function MUST return url and s3Key for MongoDB
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
    // INPUT VALIDATION - CRITICAL FIX
    // =========================================================================

    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
      console.error('❌ Invalid image buffer: buffer is null or not a Buffer');
      return {
        action: 'ERROR',
        error: 'Invalid image buffer',
        message: 'Lo siento, no pude procesar la imagen. El archivo parece estar corrupto o vacío.'
      };
    }

    if (mediaBuffer.length === 0) {
      console.error('❌ Invalid image buffer: buffer is empty (0 bytes)');
      return {
        action: 'ERROR',
        error: 'Empty image buffer',
        message: 'Lo siento, la imagen está vacía. Por favor, intenta enviarla de nuevo.'
      };
    }

    if (!mimeType || !mimeType.startsWith('image/')) {
      console.error('❌ Invalid MIME type for image:', mimeType);
      return {
        action: 'ERROR',
        error: 'Invalid MIME type',
        message: 'Lo siento, el archivo no parece ser una imagen válida.'
      };
    }

    console.log(`👁️  Vision Analysis starting... (${mediaBuffer.length} bytes, ${mimeType})`);

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
      console.error('❌ Error converting buffer to base64:', conversionError);
      return {
        action: 'ERROR',
        error: 'Base64 conversion failed',
        message: 'Lo siento, no pude procesar la imagen. Por favor, intenta enviarla de nuevo.'
      };
    }

    // =========================================================================
    // VISION API CALL WITH ERROR HANDLING
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

      // Validate analysis object has required fields
      if (!analysis.documentType || !analysis.filename) {
        throw new Error('Vision analysis missing required fields');
      }

      // Ensure arrays exist (even if empty)
      analysis.keywords = analysis.keywords || [];
      analysis.detectedText = analysis.detectedText || '';
      analysis.description = analysis.description || '';
      analysis.confidence = analysis.confidence || 50;

    } catch (visionError) {
      console.error('❌ Error in vision analysis:', visionError);
      console.error('   Stack:', visionError.stack);

      // Fallback: Ask user to describe the image
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

  } catch (error) {
    console.error('❌ Fatal error in processImage:', error);
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
      console.error('❌ Invalid document buffer');
      return {
        action: 'ERROR',
        error: 'Invalid document buffer',
        message: 'Lo siento, no pude procesar el documento. Por favor, intenta enviarlo de nuevo.'
      };
    }

    console.log(`📄 Document processing: ${mimeType} (${mediaBuffer.length} bytes)`);

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

  } catch (error) {
    console.error('❌ Error processing document:', error);
    console.error('   Stack:', error.stack);
    return {
      action: 'ERROR',
      error: error.message,
      message: 'Lo siento, hubo un error procesando el documento. Por favor, intenta de nuevo.'
    };
  }
}

/**
 * Save audio file to cloud and MongoDB
 * CRITICAL: Uploads to R2 FIRST, then saves to MongoDB with url and s3Key
 */
async function saveAudioFile(data) {
  const { mediaBuffer, mimeType, originalName, userId, userTitle, transcribedText, filenameSuggestion, confidence } = data;

  try {
    // Validate inputs
    if (!mediaBuffer || !userId) {
      throw new Error('Missing required fields: mediaBuffer or userId');
    }

    console.log(`💾 Saving audio file: ${filenameSuggestion}`);

    // =========================================================================
    // STEP 1: Upload to R2 Cloud Storage (MUST HAPPEN FIRST)
    // =========================================================================

    console.log(`   Step 1/2: Uploading to R2...`);
    const uploadResult = await uploadFile(mediaBuffer, {
      mimeType,
      originalName: originalName || 'audio.ogg',
      userId,
      isForwarded: true
    });

    // Validate upload result
    if (!uploadResult || !uploadResult.url || !uploadResult.key) {
      throw new Error('Upload to R2 failed: missing url or key in response');
    }

    console.log(`   ✅ R2 Upload complete: ${uploadResult.url}`);

    // =========================================================================
    // STEP 2: Save metadata to MongoDB (AFTER R2 upload)
    // =========================================================================

    console.log(`   Step 2/2: Saving to MongoDB...`);
    const mediaFile = await saveMediaFile({
      userId,
      userTitle,
      s3Url: uploadResult.url,       // ← REQUIRED FIELD
      s3Key: uploadResult.key,        // ← REQUIRED FIELD
      filename: filenameSuggestion,   // ← REQUIRED FIELD
      description: `Audio: ${transcribedText.substring(0, 200)}`,
      keywords: extractKeywords(transcribedText),
      detectedText: transcribedText,
      documentType: 'audio',
      confidence,
      originalName: originalName || 'audio.ogg',
      mimeType,                       // ← REQUIRED FIELD
      fileSize: uploadResult.size,
      isForwarded: true
    });

    console.log(`   ✅ MongoDB save complete: ${mediaFile._id}`);

    return mediaFile;

  } catch (error) {
    console.error('❌ Error in saveAudioFile:', error);
    console.error('   Stack:', error.stack);
    throw error; // Re-throw to be caught by calling function
  }
}

/**
 * Save image file to cloud and MongoDB
 * CRITICAL: Uploads to R2 FIRST, then saves to MongoDB with url and s3Key
 */
async function saveImageFile(data) {
  const { mediaBuffer, mimeType, originalName, userId, userTitle, analysis, userMessage, isForwarded } = data;

  try {
    // Validate inputs
    if (!mediaBuffer || !userId || !analysis) {
      throw new Error('Missing required fields: mediaBuffer, userId, or analysis');
    }

    console.log(`💾 Saving image file: ${analysis.filename}`);

    // =========================================================================
    // STEP 1: Upload to R2 Cloud Storage (MUST HAPPEN FIRST)
    // =========================================================================

    console.log(`   Step 1/2: Uploading to R2...`);
    const uploadResult = await uploadFile(mediaBuffer, {
      mimeType,
      originalName: originalName || 'image.jpg',
      userId,
      isForwarded: isForwarded || false
    });

    // Validate upload result
    if (!uploadResult || !uploadResult.url || !uploadResult.key) {
      throw new Error('Upload to R2 failed: missing url or key in response');
    }

    console.log(`   ✅ R2 Upload complete: ${uploadResult.url}`);

    // =========================================================================
    // STEP 2: Save metadata to MongoDB (AFTER R2 upload)
    // =========================================================================

    console.log(`   Step 2/2: Saving to MongoDB...`);
    const mediaFile = await saveMediaFile({
      userId,
      userTitle,
      s3Url: uploadResult.url,       // ← REQUIRED FIELD
      s3Key: uploadResult.key,        // ← REQUIRED FIELD
      filename: analysis.filename,    // ← REQUIRED FIELD
      description: analysis.description || '',
      keywords: analysis.keywords || [],
      detectedText: analysis.detectedText || '',
      documentType: analysis.documentType || 'photo',
      confidence: analysis.confidence || 0,
      originalName: originalName || 'image.jpg',
      mimeType,                       // ← REQUIRED FIELD
      fileSize: uploadResult.size,
      isForwarded: isForwarded || false
    });

    console.log(`   ✅ MongoDB save complete: ${mediaFile._id}`);

    return mediaFile;

  } catch (error) {
    console.error('❌ Error in saveImageFile:', error);
    console.error('   Stack:', error.stack);
    throw error; // Re-throw to be caught by calling function
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
    console.error('❌ Error creating pending confirmation:', error);
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

    return filename || 'audio-file'; // Fallback

  } catch (error) {
    console.error('❌ Error generating filename:', error);
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

    // Simple keyword extraction (can be improved with NLP)
    const words = text.toLowerCase()
      .replace(/[^\w\sáéíóúñü]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3);

    // Get unique words
    const unique = [...new Set(words)];

    // Return top 10
    return unique.slice(0, 10);
  } catch (error) {
    console.error('❌ Error extracting keywords:', error);
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
  const femenino = ['cedula', 'factura', 'foto', 'imagen'];
  return femenino.includes(word.toLowerCase()) ? 'una' : 'un';
}

module.exports = {
  processMedia
};
