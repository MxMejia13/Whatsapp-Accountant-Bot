/**
 * AI Agent Service - Privacy-First Architecture
 *
 * This service handles the main AI conversation flow using OpenAI Function Calling.
 * It allows GPT-4o to intelligently decide when to execute tools (save, search, etc.)
 * with full privacy awareness and permission control.
 */

const OpenAI = require('openai');
const User = require('../models/User');
const { tools } = require('../config/tools');
const {
  MediaFile,
  saveMediaFile,
  searchMediaFiles,
  getRecentMedia,
  getUserStats,
  isUserAdmin,
  verifyFileAccess
} = require('../database/mongodb');
const { requestFileAccess } = require('./PermissionService');
const { scheduleReminder } = require('./SchedulerService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Get polite name for addressing the user
 * Priority: profileData.displayNames.preferred > "Sr./Sra. {Capitalized Alias}"
 *
 * @param {Object} user - The user object from MongoDB
 * @returns {string} - Polite name for addressing the user
 */
function getPoliteName(user) {
  if (!user) {
    return 'Estimado Usuario/a';
  }

  // Priority 1: Check if custom displayNames are configured
  if (user.profileData && user.profileData.displayNames && user.profileData.displayNames.preferred) {
    return user.profileData.displayNames.preferred;
  }

  // Priority 2: Fall back to "Sr./Sra. {Capitalized Alias}"
  const alias = user.alias || user.title || 'Usuario/a';

  // Capitalize first letter
  const capitalized = alias.charAt(0).toUpperCase() + alias.slice(1);

  return `Sr. ${capitalized}`;
}

/**
 * Build the system prompt with user context
 */
function buildSystemPrompt(user, isAdmin, hasMediaAttached, mediaType, mediaAnalysis, isVoice = false, replyContext = null) {
  // Get polite display name (checks profileData.displayNames first)
  const politeName = getPoliteName(user);

  // User context with alias, full name, and email
  let userContext = '';
  if (user) {
    const fullName = user.fullName || user.name || '';
    const email = user.email || 'Not Set';

    userContext = `\n\n👤 USER CONTEXT: You are speaking with ${politeName}${fullName ? ` (${fullName})` : ''}. Address the user respectfully using "${politeName}" when greeting or responding. ${email !== 'Not Set' ? `Their email is ${email}.` : ''} Never ask the user for their name.`;
  } else {
    userContext = '\n\n👤 USER CONTEXT: You are speaking with Estimado Usuario/a. Address the user respectfully.';
  }

  const adminContext = isAdmin
    ? `\n\n🔐 ADMIN PRIVILEGES: You have admin access. You can search ALL files in the system. Files you don't own will show as LOCKED with metadata only. Use \`request_file_access\` to request permission from the owner.`
    : '';

  const mediaContext = hasMediaAttached && mediaAnalysis
    ? `\n\n📎 MEDIA CONTEXT: The user sent a ${mediaType} file. AI Analysis:\n${mediaAnalysis.description || 'No description'}\nKeywords: ${mediaAnalysis.keywords ? mediaAnalysis.keywords.join(', ') : 'none'}\nDocument Type: ${mediaAnalysis.documentType || 'unknown'}\nConfidence: ${mediaAnalysis.confidence || 0}%`
    : '';

  const voiceContext = isVoice
    ? `\n\n🎤 VOICE INPUT: The user's message was transcribed from an audio note using Whisper AI. You successfully received and understood their voice message. Respond naturally and conversationally, acknowledging the spoken nature of their request. If they ask whether you can "read", "hear", "understand", or "process" audio/voice notes, confirm that YES, you can transcribe and understand voice messages perfectly.`
    : '';

  // CONTEXTUAL AWARENESS: Reply Context
  const replyContextMessage = replyContext
    ? `\n\n🔗 REPLY CONTEXT: The user is replying to a previous message/document. IMPORTANT: Prioritize analyzing this context in your response.
📄 **Document Being Replied To:**
- **Filename:** ${replyContext.filename || 'Unknown'}
- **Type:** ${replyContext.documentType || 'Unknown'}
- **Description:** ${replyContext.description || 'No description available'}
${replyContext.detectedText ? `- **Content/Text:** ${replyContext.detectedText.substring(0, 500)}${replyContext.detectedText.length > 500 ? '...' : ''}` : ''}
${replyContext.documentDate ? `- **Document Date:** ${new Date(replyContext.documentDate).toLocaleDateString()}` : ''}
${replyContext.vendorName ? `- **Vendor:** ${replyContext.vendorName}` : ''}
${replyContext.amount ? `- **Amount:** $${replyContext.amount}` : ''}
- **File ID:** ${replyContext.fileId}
- **Uploaded:** ${replyContext.createdAt ? new Date(replyContext.createdAt).toLocaleDateString() : 'Unknown'}

**Instructions:** The user's current message is in response to this document. Consider this context when generating your response. If the user is asking about "this" or "that" document, they are referring to the document above.`
    : '';

  return `You are a Privacy-First Intelligent WhatsApp Assistant with expertise in document management and accounting support. You are a helpful, knowledgeable assistant who can answer questions on a wide range of topics.${userContext}${adminContext}${mediaContext}${voiceContext}${replyContextMessage}

## CORE CAPABILITIES:
- **PRIMARY FOCUS:** Document management, file storage, and accounting support
- **GENERAL KNOWLEDGE:** You can answer general questions about any topic using your built-in knowledge
- **DYNAMIC INFORMATION:** You have access to real-time information via tools (current time, scheduling, etc.)

## LANGUAGE POLICY:
- **Default: SPANISH** - Always respond in Spanish unless user explicitly uses English
- **Understanding: ALL languages** - You understand French, German, Portuguese, etc.
- **Responses: Spanish or English ONLY**

## PRIVACY & SECURITY PRINCIPLES:

### 🔐 DATA SOVEREIGNTY
- Users can ONLY retrieve files they uploaded OR files shared with them
- You cannot access files owned by other users without permission
- ADMINS can search all files but see LOCKED metadata for files they don't own
- NEVER reveal private information from files you don't have access to

### 🔓 PERMISSION PROTOCOL (Admin Only)
When admin searches and finds LOCKED files:
1. File shows: {filename, owner, documentType, status:"LOCKED", fileId}
2. Ask admin: "¿Quieres solicitar acceso a este archivo?"
3. If yes: Call \`request_file_access\` with the fileId
4. System sends WhatsApp to owner: "⚠️ [Admin] requesting access to [filename]. Reply AUTHORIZE or DENY"
5. When owner authorizes, file is auto-shared and forwarded to admin

## CORE INTELLIGENCE:

### 1. SMART SAVE ("The Tagger")
When user sends a file:
- **AUTOMATIC:** System already analyzed it with GPT-4o Vision/Whisper
- **YOUR JOB:** Decide if user wants to save it
- **DEFAULT:** YES, save it (unless they're asking a question)
- **CALL:** \`save_file\` with custom_name ONLY if user specified (e.g., "save as cedula max mejia")
- **SYSTEM HANDLES:** Keywords with synonyms, OCR, transcription, confidence scoring

Examples:
- User sends ID card → Call \`save_file\` with no custom_name (system auto-generates)
- User: "Save this as my passport 2024" → Call \`save_file\` with custom_name="passport 2024"
- User: "What does this say?" → NO save, just analyze

### 2. SMART SEARCH ("The Expander")
When user wants to find a file:
- **CRITICAL:** ALWAYS expand query with synonyms
- **Examples:**
  - "mi cedula" → search "cedula id identificacion documento personal dominicana"
  - "passport" → search "passport pasaporte travel documento viaje international"
  - "receipt" → search "receipt factura recibo comprobante payment"
  - "contract" → search "contract contrato agreement acuerdo legal"

**Search Process:**
1. Expand query internally with synonyms
2. Call \`search_files\` with expanded query
3. If results found: Present them clearly
4. If LOCKED results (admin only): Explain and offer to request access
5. If no results: Suggest broader search terms

### 3. PROACTIVE BEHAVIOR
- **Files sent:** Assume save intent unless asking question
- **Search requests:** Be smart about synonyms
- **Ambiguous requests:** Ask for clarification
- **Admin locked files:** Explain permission workflow

## AVAILABLE TOOLS:

1. **\`save_file\`** - Save media with AI-generated metadata
   - Use when: User sends file and wants to store it
   - Parameters: custom_name (optional, only if user specified)
   - System handles: Keywords, OCR, transcription, confidence

2. **\`search_files\`** - Smart search with synonym expansion
   - Use when: User wants to find/retrieve a file
   - Parameters: query (WITH SYNONYMS), document_type, limit
   - Returns: User's files OR shared files (admin sees LOCKED for others)

3. **\`request_file_access\`** - Request permission to locked file (ADMIN ONLY)
   - Use when: Admin wants access to LOCKED file
   - Parameters: file_id (from search results)
   - Triggers: Permission handshake workflow

4. **\`get_my_stats\`** - File storage statistics
   - Use when: User asks about their files/storage
   - Returns: Total files, breakdown by type

5. **\`list_recent_files\`** - Recent files list
   - Use when: User asks what files they have
   - Parameters: limit, document_type

6. **\`schedule_reminder\`** - Schedule WhatsApp reminders (one-time or recurring)
   - Use when: User wants to schedule a future message/reminder
   - Parameters: when, description, recipients (optional), frequency (optional)
   - **CRITICAL UX RULES:**
     * **Single-Turn Execution:** Gather ALL info (task, time, frequency) from user's initial message
     * **No Unnecessary Confirmations:** Don't ask "¿Podrías confirmarme...?" unless info is truly missing
     * **Infer Frequency Intelligently:**
       - "cumpleaños", "aniversario", "todos los años" → frequency: "yearly"
       - "cada mes", "mensualmente" → frequency: "monthly"
       - "cada semana", "semanalmente" → frequency: "weekly"
       - "todos los días", "diariamente" → frequency: "daily"
       - Default → frequency: "once"
     * **Cancellation Detection:** If user says "No", "Cancelar", "Detener", abort immediately and say: "Entendido, tarea cancelada."
   - Examples:
     * "Recuérdame mañana a las 9 AM llamar al contador" → Call immediately with inferred params
     * "El 10 de diciembre es el cumpleaños de Max, recuérdamelo" → frequency: "yearly"

7. **\`get_current_time\`** - Get current date and time
   - Use when: User asks "what time is it", "what day is today", "what's the date"
   - Also use when: You need current time for calculations (age, time until event, days since, etc.)
   - Returns: Current date and time in ISO 8601 format
   - Examples:
     * "¿Qué hora es?" → Call \`get_current_time\`, respond with formatted time
     * "¿Cuántos días faltan para Navidad?" → Call \`get_current_time\`, calculate difference
     * "¿Cuántos años tiene alguien nacido en 1990?" → Call \`get_current_time\`, calculate age

## EXAMPLES:

**Example 1: Smart Save**
User: [sends image of Dominican ID]
System: [Auto-analyzed: "Dominican ID card, keywords: cedula id identificacion..."]
You: Call \`save_file\` (no custom_name)
Response: "✅ Cédula guardada, ${politeName}! Generé palabras clave inteligentes para búsqueda rápida."

**Example 2: Smart Search**
User: "Enviame mi cedula"
You: Call \`search_files\` with query "cedula id identificacion documento personal dominicana"
Response: [If found] "📎 Aquí está tu cédula, ${politeName}!"

**Example 3: Admin Locked File**
User (admin): "Busca el pasaporte de Jose"
You: Call \`search_files\` with query "pasaporte passport jose travel documento"
Results: [{status:"LOCKED", filename:"passport-jose.jpg", owner:"Sr. Jose", fileId:"..."}]
Response: "Encontré el pasaporte de Sr. Jose, pero está LOCKED (es su archivo privado). ¿Quieres que solicite permiso de acceso?"
User: "Si"
You: Call \`request_file_access\` with file_id
Response: "✅ Solicitud enviada a Sr. Jose. Recibirás el archivo cuando autorice."

**Example 4: Just Analyzing**
User: [sends receipt] "Cuanto pagué aquí?"
System: [Auto-analyzed OCR: "Total: $45.50"]
You: NO TOOL CALL - just read analysis
Response: "Según el recibo, pagaste $45.50. ¿Quieres que guarde este recibo para referencia futura?"

## GENERAL KNOWLEDGE & INFORMATION:

You are a knowledgeable assistant capable of answering questions on ANY topic:
- **History, Science, Math, Geography:** Use your built-in knowledge to provide accurate answers
- **Current Events:** Explain you have knowledge up to January 2025 and may not know very recent events
- **Time-Sensitive Questions:** ALWAYS call \`get_current_time\` when needed for:
  * "What time is it?", "What day is today?", "What's the date?"
  * Age calculations, countdowns, days since/until events
  * Any question requiring current date/time
- **Be Helpful:** Don't limit yourself to only document/accounting questions
- **Be Honest:** If you don't know something, say so. Don't make up information.
- **Stay Relevant:** For lengthy explanations, keep answers concise and to the point

## REMEMBER:
- Be proactive and intelligent
- ALWAYS expand search queries with synonyms
- Respect privacy boundaries
- Explain permission workflow clearly to admins
- Be conversational and helpful
- Default language: SPANISH
- **Answer ALL questions** - not just document/accounting related
- Use \`get_current_time\` for any time-sensitive information

### 📧 EMAIL COMPOSITION (send_email tool):
When sending emails on behalf of the user:
- **Subject:** Always compose a clear, descriptive, professional subject line
- **Body:** Write a complete, well-formatted message that sounds professional and helpful
- **Attachments:** The system automatically resolves filenames and generates secure download links
- **Recipients:** You can use user aliases (e.g., "Vinicio") - the system will look up their email automatically
- **Example:** If user says "Send my receipt to Vinicio", compose a complete professional email like:
  - Subject: "Recibo de compra - [Date]"
  - Body: "Hola Vinicio,\n\nTe envío el recibo solicitado. Puedes descargarlo usando el enlace seguro incluido abajo.\n\nSaludos!"

## 🚫 CANCELLATION DETECTION:
When user says "No", "Cancelar", "Detener", "Stop", "Cancel", or similar:
- **Immediately abort** the current operation
- **Do NOT call any tools**
- Respond simply: "Entendido, tarea cancelada." or "Understood, task cancelled."
- Return to idle state

## 🎉 NUEVAS CARACTERÍSTICAS V3.0

Cuando el usuario pregunte "¿Cuáles son tus nuevas funciones?", "¿Qué hay de nuevo?", "¿Qué características tienes?" o similar, responde con esta lista:

**Versión 3.0 - Características Principales:**

1. **🔒 Privacidad "Peer-to-Peer"**
   - Control de acceso estricto por usuario
   - Solo puedes ver tus propios archivos (o los que te compartan)
   - Los administradores necesitan tu autorización para ver tus documentos privados
   - Sistema de "Permission Handshake" (te llegará un WhatsApp pidiendo permiso)

2. **🧠 Búsqueda con Lenguaje Natural**
   - Puedes buscar usando frases completas y naturales
   - Ejemplos: "Búscame la factura de Bravo del mes pasado", "¿Dónde está mi cédula?"
   - Expansión automática de sinónimos (busca "cedula" y encuentra "identificación", "ID", etc.)
   - Búsqueda inteligente en texto OCR extraído de imágenes

3. **📧 Bóveda de Correo Electrónico**
   - Reenvía facturas y adjuntos a: **bot@mejiafamily.app**
   - Los archivos se guardan automáticamente en tu bóveda personal
   - Recibirás confirmación por WhatsApp cuando se procesen
   - Funciona con PDFs, imágenes, documentos, etc.

4. **📊 Reportes y Resúmenes "On-Demand"**
   - Generación de resúmenes contables cuando los solicites
   - Reportes PDF descargables
   - Análisis de gastos por categoría
   - Estadísticas de tus archivos guardados

5. **⏰ Agenda Inteligente**
   - Programación de recordatorios
   - Gestión de fechas importantes
   - Notificaciones automáticas por WhatsApp

**Nota:** Todas estas características están diseñadas con **privacidad primero**. Tus documentos son tuyos y solo tuyos.`;
}

/**
 * Parse natural language time expressions to Date objects
 * Supports Spanish and English
 */
function parseNaturalTime(expression) {
  const now = new Date();
  const expr = expression.toLowerCase().trim();

  // Relative time expressions
  if (expr.match(/en (\d+) (minuto|minutos)/)) {
    const minutes = parseInt(expr.match(/\d+/)[0]);
    return new Date(now.getTime() + minutes * 60 * 1000);
  }

  if (expr.match(/en (\d+) (hora|horas)/)) {
    const hours = parseInt(expr.match(/\d+/)[0]);
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  }

  if (expr.match(/en (\d+) (día|días|dia|dias)/)) {
    const days = parseInt(expr.match(/\d+/)[0]);
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    return date;
  }

  // Tomorrow/Mañana
  if (expr.match(/ma[ñn]ana/i) || expr.match(/tomorrow/i)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Check if time is specified
    const timeMatch = expr.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const meridiem = timeMatch[3];

      if (meridiem && meridiem.toLowerCase() === 'pm' && hours < 12) {
        hours += 12;
      } else if (meridiem && meridiem.toLowerCase() === 'am' && hours === 12) {
        hours = 0;
      }

      tomorrow.setHours(hours, minutes, 0, 0);
    } else {
      tomorrow.setHours(9, 0, 0, 0); // Default 9 AM
    }

    return tomorrow;
  }

  // Specific days of the week
  const daysOfWeek = {
    'lunes': 1, 'monday': 1,
    'martes': 2, 'tuesday': 2,
    'miércoles': 3, 'miercoles': 3, 'wednesday': 3,
    'jueves': 4, 'thursday': 4,
    'viernes': 5, 'friday': 5,
    'sábado': 6, 'sabado': 6, 'saturday': 6,
    'domingo': 0, 'sunday': 0
  };

  for (const [dayName, dayNum] of Object.entries(daysOfWeek)) {
    if (expr.includes(dayName)) {
      const targetDate = new Date(now);
      const currentDay = targetDate.getDay();
      let daysUntilTarget = dayNum - currentDay;

      if (daysUntilTarget <= 0) {
        daysUntilTarget += 7; // Next week
      }

      targetDate.setDate(targetDate.getDate() + daysUntilTarget);

      // Check if time is specified
      const timeMatch = expr.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const meridiem = timeMatch[3];

        if (meridiem && meridiem.toLowerCase() === 'pm' && hours < 12) {
          hours += 12;
        } else if (meridiem && meridiem.toLowerCase() === 'am' && hours === 12) {
          hours = 0;
        }

        targetDate.setHours(hours, minutes, 0, 0);
      } else {
        targetDate.setHours(9, 0, 0, 0); // Default 9 AM
      }

      return targetDate;
    }
  }

  // Try to parse as ISO date or standard date format
  try {
    const parsedDate = new Date(expression);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  } catch (e) {
    // Fall through
  }

  // Default: 1 hour from now
  return new Date(now.getTime() + 60 * 60 * 1000);
}

/**
 * Execute a tool call - Privacy-Aware Edition
 */
async function executeTool(toolName, args, context) {
  const { phoneNumber, user, isAdmin, mediaAnalysis } = context;

  console.log(`🔧 Executing tool: ${toolName} with args:`, JSON.stringify(args, null, 2));

  try {
    switch (toolName) {
      case 'save_file': {
        if (!mediaAnalysis) {
          return {
            success: false,
            error: 'No media analysis available. User must send a file first.'
          };
        }

        const { custom_name } = args;

        // Use custom name if provided, otherwise use AI-generated filename
        const filename = custom_name || mediaAnalysis.filename;

        // Save to MongoDB with full metadata
        const savedFile = await saveMediaFile({
          ownerPhoneNumber: phoneNumber,
          ownerTitle: user?.alias || user?.title || phoneNumber,
          url: mediaAnalysis.url, // S3/R2 URL
          s3Key: mediaAnalysis.s3Key,
          filename: filename,
          description: mediaAnalysis.description,
          keywords: mediaAnalysis.keywords,
          detectedText: mediaAnalysis.detectedText,
          documentType: mediaAnalysis.documentType,
          confidence: mediaAnalysis.confidence,
          originalName: mediaAnalysis.originalName,
          mimeType: mediaAnalysis.mimeType,
          fileSize: mediaAnalysis.fileSize,
          isForwarded: mediaAnalysis.isForwarded || false
        });

        console.log(`✅ File saved to MongoDB: ${savedFile._id}`);

        return {
          success: true,
          message: 'File saved successfully with AI-generated keywords',
          file_id: savedFile._id,
          filename: savedFile.filename,
          keywords: savedFile.keywords,
          document_type: savedFile.documentType,
          confidence: savedFile.confidence
        };
      }

      case 'search_files': {
        const { query, document_type, limit } = args;

        // Perform privacy-aware search
        const results = await searchMediaFiles(
          phoneNumber,
          query,
          isAdmin,
          limit || 5
        );

        // Filter by document type if specified
        let filtered = results;
        if (document_type && document_type !== 'all') {
          filtered = results.filter(f => f.documentType === document_type);
        }

        return {
          success: true,
          results: filtered.map(file => {
            // If LOCKED (admin only), return limited metadata
            if (file.status === 'LOCKED') {
              return {
                file_id: file._id,
                filename: file.filename,
                owner: file.owner,
                document_type: file.documentType,
                created_at: file.createdAt,
                status: 'LOCKED',
                message: file.message
              };
            }

            // Full access - return complete metadata
            return {
              file_id: file._id,
              filename: file.filename,
              description: file.description,
              keywords: file.keywords,
              document_type: file.documentType,
              created_at: file.createdAt,
              url: file.url,
              owner: file.ownerTitle || file.ownerPhoneNumber
            };
          }),
          count: filtered.length,
          query: query
        };
      }

      case 'request_file_access': {
        const { file_id } = args;

        // Check if user is admin
        if (!isAdmin) {
          return {
            success: false,
            error: 'Only administrators can request file access'
          };
        }

        // Request access via PermissionService
        const result = await requestFileAccess(
          file_id,
          phoneNumber,
          user?.alias || user?.title || phoneNumber
        );

        return result;
      }

      case 'get_my_stats': {
        const { include_breakdown } = args;

        const stats = await getUserStats(phoneNumber);

        if (!stats) {
          return {
            success: false,
            error: 'User stats not found'
          };
        }

        return {
          success: true,
          stats: {
            total_files: stats.totalFiles,
            total_messages: stats.totalMessages,
            breakdown: include_breakdown ? stats.breakdown : null
          }
        };
      }

      case 'list_recent_files': {
        const { limit, document_type } = args;

        // Get recent files (privacy-enforced - only owner's files)
        let query = { ownerPhoneNumber: phoneNumber };
        if (document_type && document_type !== 'all') {
          query.documentType = document_type;
        }

        const files = await MediaFile.find(query)
          .sort({ createdAt: -1 })
          .limit(limit || 10)
          .lean();

        return {
          success: true,
          files: files.map(file => ({
            file_id: file._id,
            filename: file.filename,
            description: file.description,
            document_type: file.documentType,
            created_at: file.createdAt
          })),
          count: files.length
        };
      }

      case 'schedule_reminder': {
        const { when, description, recipients, frequency } = args;

        // Parse natural language time
        const executionTime = parseNaturalTime(when);

        // Default recipients to current user
        const recipientList = recipients && recipients.length > 0
          ? recipients
          : ['yo'];

        // Default frequency to 'once'
        const recurrence = frequency || 'once';

        // Convert frequency to Agenda repeat format
        const repeatMapping = {
          'once': null,
          'daily': '1 day',
          'weekly': '1 week',
          'monthly': '1 month',
          'yearly': '1 year'
        };
        const repeatInterval = repeatMapping[recurrence];

        console.log(`📅 Scheduling ${recurrence} reminder for: ${executionTime.toISOString()}`);
        console.log(`   Description: ${description}`);
        console.log(`   Recipients: ${recipientList.join(', ')}`);
        console.log(`   Recurrence: ${repeatInterval || 'one-time'}`);

        try {
          const result = await scheduleReminder(
            executionTime,
            recipientList,
            description,
            phoneNumber.replace('whatsapp:', ''),
            repeatInterval
          );

          if (!result.success) {
            return {
              success: false,
              error: result.error || 'Failed to schedule reminder'
            };
          }

          // Format confirmation message
          const timeString = executionTime.toLocaleString('es-ES', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });

          // Add recurrence info to message
          const recurrenceText = recurrence !== 'once'
            ? ` (se repetirá ${recurrence === 'yearly' ? 'anualmente' : recurrence === 'monthly' ? 'mensualmente' : recurrence === 'weekly' ? 'semanalmente' : 'diariamente'})`
            : '';

          return {
            success: true,
            message: `Reminder scheduled successfully`,
            scheduled_for: result.scheduledFor,
            scheduled_for_readable: timeString + recurrenceText,
            recipient_count: result.recipientCount,
            recipients: result.recipients,
            job_id: result.jobId,
            description: description,
            frequency: recurrence,
            repeat_interval: repeatInterval
          };

        } catch (error) {
          console.error('Error scheduling reminder:', error);
          return {
            success: false,
            error: `Failed to schedule: ${error.message}`
          };
        }
      }

      case 'get_current_time': {
        // Simple synchronous function - returns current date/time
        const now = new Date();
        const isoString = now.toISOString();

        // Also provide human-readable formats for convenience
        const readable = {
          date: now.toLocaleDateString('es-ES', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          time: now.toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };

        console.log(`🕐 Current time requested: ${isoString}`);

        return {
          success: true,
          iso: isoString,
          timestamp: now.getTime(),
          year: now.getFullYear(),
          month: now.getMonth() + 1, // JavaScript months are 0-indexed
          day: now.getDate(),
          hour: now.getHours(),
          minute: now.getMinutes(),
          second: now.getSeconds(),
          dayOfWeek: now.getDay(), // 0 = Sunday
          readable: readable
        };
      }

      case 'list_documents': {
        // List user's documents with optional filters
        const { documentType, limit = 20, searchQuery } = args;

        try {
          const { searchMediaFiles } = require('../database/mongodb');

          // Build query
          let query = { ownerPhoneNumber: phoneNumber };

          if (documentType) {
            query.documentType = documentType;
          }

          // If searchQuery provided, use text search
          if (searchQuery) {
            const results = await searchMediaFiles(phoneNumber, searchQuery, limit);
            return {
              success: true,
              files: results.map(file => ({
                filename: file.filename,
                description: file.description,
                documentType: file.documentType,
                date: file.documentDate || file.createdAt,
                vendorName: file.vendorName,
                amount: file.amount,
                url: file.url
              })),
              count: results.length
            };
          }

          // Otherwise, list recent files
          const { MediaFile } = require('../database/mongodb');
          const files = await MediaFile.find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .select('filename description documentType documentDate vendorName amount createdAt url')
            .lean();

          return {
            success: true,
            files: files.map(file => ({
              filename: file.filename,
              description: file.description,
              documentType: file.documentType,
              date: file.documentDate || file.createdAt,
              vendorName: file.vendorName,
              amount: file.amount,
              url: file.url
            })),
            count: files.length
          };
        } catch (error) {
          console.error('Error listing documents:', error);
          return {
            success: false,
            error: `Error listing documents: ${error.message}`
          };
        }
      }

      case 'delete_document': {
        // Delete a document from both R2 and MongoDB
        const { filename } = args;

        if (!filename) {
          return {
            success: false,
            error: 'Filename is required'
          };
        }

        try {
          const { MediaFile } = require('../database/mongodb');
          const { deleteFile } = require('./CloudStorage');

          // Find the file
          const file = await MediaFile.findOne({
            ownerPhoneNumber: phoneNumber,
            filename: filename
          });

          if (!file) {
            return {
              success: false,
              error: `File not found: ${filename}`
            };
          }

          // Delete from R2
          if (file.s3Key) {
            try {
              await deleteFile(file.s3Key);
              console.log(`✅ Deleted from R2: ${file.s3Key}`);
            } catch (r2Error) {
              console.error(`⚠️  R2 deletion failed (continuing):`, r2Error.message);
              // Continue even if R2 deletion fails
            }
          }

          // Delete from MongoDB
          await MediaFile.deleteOne({ _id: file._id });
          console.log(`✅ Deleted from MongoDB: ${file.filename}`);

          return {
            success: true,
            message: `Successfully deleted: ${filename}`,
            deletedFile: {
              filename: file.filename,
              documentType: file.documentType,
              createdAt: file.createdAt
            }
          };
        } catch (error) {
          console.error('Error deleting document:', error);
          return {
            success: false,
            error: `Error deleting document: ${error.message}`
          };
        }
      }

      case 'send_email': {
        // Smart email dispatch with user alias lookup and filename resolution
        const { recipientEmail: recipientInput, subject, body, filename_or_key, s3Key } = args;

        if (!recipientInput || !subject || !body) {
          return {
            success: false,
            error: 'recipientEmail, subject, and body are required'
          };
        }

        try {
          const nodemailer = require('nodemailer');
          const { getSignedUrl } = require('./CloudStorage');

          // ===============================================
          // SMART USER LOOKUP: Resolve alias to email
          // ===============================================
          let resolvedEmail = recipientInput;
          let resolvedAlias = null;

          // Email validation regex (RFC 5322 simplified)
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          const isValidEmail = emailRegex.test(recipientInput);

          // If not a valid email format, treat as user alias and lookup
          if (!isValidEmail) {
            console.log(`🔍 "${recipientInput}" is not a valid email format - treating as user alias`);
            console.log(`   Performing unified database search (alias, fullName, name) with email validation...`);

            // ===============================================
            // UNIFIED CASE-INSENSITIVE SEARCH (Single Query)
            // ===============================================
            // Search all three fields simultaneously using $or
            // CRITICAL: Only return users with valid email addresses
            // This prevents finding placeholder/incomplete user profiles
            const searchPattern = new RegExp(`^${recipientInput.trim()}$`, 'i');

            const user = await User.findOne({
              $and: [
                {
                  $or: [
                    { alias: { $regex: searchPattern } },
                    { fullName: { $regex: searchPattern } },
                    { name: { $regex: searchPattern } }
                  ]
                },
                { email: { $exists: true, $ne: null, $ne: '' } }
              ]
            });

            console.log(`   Query executed: $or[alias, fullName, name] + email validation (must exist and not be empty)`);

            // Check if user was found and has email
            if (user) {
              if (user.email && user.email.trim()) {
                resolvedEmail = user.email;
                resolvedAlias = user.alias || user.fullName || user.name;
                console.log(`✅ Resolved "${recipientInput}" → ${resolvedEmail} (${resolvedAlias})`);
              } else {
                console.error(`❌ User "${recipientInput}" found but has no email configured`);
                console.error(`   User ID: ${user._id}`);
                console.error(`   Alias: ${user.alias}`);
                console.error(`   Email: ${user.email || 'NULL'}`);

                return {
                  success: false,
                  error: `Found user "${recipientInput}" but they have no email address configured in the system. Please ask them to set up their email first, or use a direct email address.`
                };
              }
            } else {
              console.error(`❌ User "${recipientInput}" not found in database`);
              console.error(`   Tried searching: alias, fullName, name fields`);

              return {
                success: false,
                error: `User "${recipientInput}" not found in the system. Please use a valid email address (e.g., user@example.com) or ensure the user is registered with that alias.`
              };
            }
          } else {
            // Valid email format detected
            console.log(`✅ "${recipientInput}" is a valid email format - using directly`);
            resolvedEmail = recipientInput;
          }

          // Final validation: ensure we have a valid email
          if (!resolvedEmail || !emailRegex.test(resolvedEmail)) {
            return {
              success: false,
              error: `Failed to resolve "${recipientInput}" to a valid email address. Final resolved value: ${resolvedEmail || 'NULL'}`
            };
          }

          // ===============================================
          // SMART FILE LOOKUP: Resolve filename to s3Key
          // ===============================================
          let resolvedS3Key = filename_or_key || s3Key;
          let resolvedFilename = null;

          if (resolvedS3Key) {
            // Check if it looks like a filename (no slashes) vs s3Key (has slashes like "media/...")
            if (!resolvedS3Key.includes('/')) {
              // Treat as filename - lookup in MongoDB
              console.log(`🔍 Attachment "${resolvedS3Key}" appears to be a filename, looking up s3Key...`);

              const file = await MediaFile.findOne({
                filename: resolvedS3Key
              });

              if (file && file.s3Key) {
                resolvedFilename = file.filename;
                resolvedS3Key = file.s3Key;
                console.log(`✅ Resolved filename "${resolvedFilename}" → ${resolvedS3Key}`);
              } else {
                console.warn(`⚠️  File "${resolvedS3Key}" not found in database`);
                return {
                  success: false,
                  error: `File "${resolvedS3Key}" not found in the system. Please verify the filename is correct.`
                };
              }
            } else {
              console.log(`📎 Using provided s3Key: ${resolvedS3Key}`);
            }
          }

          // ===============================================
          // SMTP CONFIGURATION (Fixed for ETIMEDOUT)
          // ===============================================
          const smtpPort = parseInt(process.env.SMTP_PORT) || 587;
          const isSecurePort = smtpPort === 465;

          const transportConfig = {
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: smtpPort,
            secure: isSecurePort, // true for 465, false for other ports
            auth: {
              user: process.env.SMTP_USER || process.env.SMTP_EMAIL,
              pass: process.env.SMTP_PASS
            },
            // Enhanced connection settings to fix ETIMEDOUT
            connectionTimeout: 10000, // 10 seconds
            greetingTimeout: 10000,
            socketTimeout: 10000
          };

          // Add TLS configuration for port 587 (STARTTLS)
          if (!isSecurePort) {
            transportConfig.tls = {
              rejectUnauthorized: false, // Accept self-signed certificates (for development)
              minVersion: 'TLSv1.2' // Use modern TLS (Resend compatible)
            };
            transportConfig.requireTLS = true; // Force STARTTLS upgrade
          }

          console.log(`📧 Configuring SMTP: ${transportConfig.host}:${transportConfig.port} (secure: ${transportConfig.secure})`);

          const transporter = nodemailer.createTransport(transportConfig);

          // ===============================================
          // COMPOSE EMAIL WITH ATTACHMENT LINK
          // ===============================================
          const mailOptions = {
            from: process.env.SMTP_FROM || process.env.SMTP_EMAIL,
            to: resolvedEmail,
            subject: subject,
            text: body,
            html: body.replace(/\n/g, '<br>')
          };

          // If file attachment provided, generate secure download URL
          if (resolvedS3Key) {
            try {
              const downloadUrl = await getSignedUrl(resolvedS3Key, 604800); // 7 days expiration
              const attachmentName = resolvedFilename || 'archivo';

              // Add prominent download link to email body
              mailOptions.text += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📎 ARCHIVO ADJUNTO: ${attachmentName}\n🔗 Descargar (válido por 7 días):\n${downloadUrl}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

              mailOptions.html += `
                <br><br>
                <div style="border: 2px solid #4CAF50; padding: 15px; border-radius: 8px; background-color: #f9f9f9; margin-top: 20px;">
                  <p style="margin: 0; font-size: 16px;"><strong>📎 Archivo Adjunto:</strong> ${attachmentName}</p>
                  <p style="margin: 10px 0 0 0;">
                    <a href="${downloadUrl}"
                       style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                      🔗 Descargar Archivo
                    </a>
                  </p>
                  <p style="margin: 10px 0 0 0; font-size: 12px; color: #666;">
                    <em>Este enlace es válido por 7 días</em>
                  </p>
                </div>
              `;

              console.log(`📧 Added secure download link for: ${attachmentName} (7-day expiration)`);
            } catch (urlError) {
              console.error(`⚠️  Failed to generate download URL:`, urlError.message);
              return {
                success: false,
                error: `Failed to generate download link for attachment: ${urlError.message}`
              };
            }
          }

          // ===============================================
          // SEND EMAIL
          // ===============================================
          console.log(`📤 Sending email to ${resolvedEmail}...`);
          const info = await transporter.sendMail(mailOptions);

          console.log(`✅ Email sent successfully!`);
          console.log(`   To: ${resolvedEmail}${resolvedAlias ? ` (${resolvedAlias})` : ''}`);
          console.log(`   Subject: ${subject}`);
          console.log(`   Message ID: ${info.messageId}`);
          console.log(`   Attachment: ${resolvedS3Key ? 'Yes' : 'No'}`);

          return {
            success: true,
            message: `Email sent successfully to ${resolvedEmail}${resolvedAlias ? ` (${resolvedAlias})` : ''}`,
            messageId: info.messageId,
            recipient: resolvedEmail,
            recipientAlias: resolvedAlias,
            attachmentIncluded: !!resolvedS3Key,
            attachmentFilename: resolvedFilename
          };
        } catch (error) {
          console.error('❌ Error sending email:', error);
          console.error('   Error code:', error.code);
          console.error('   Error message:', error.message);

          // Provide helpful error messages
          let errorMessage = error.message;
          if (error.code === 'ETIMEDOUT') {
            errorMessage = 'SMTP connection timeout. Please check your SMTP_HOST, SMTP_PORT, and network connectivity. Ensure firewall allows outbound connections on the SMTP port.';
          } else if (error.code === 'EAUTH') {
            errorMessage = 'SMTP authentication failed. Please verify SMTP_USER and SMTP_PASS are correct.';
          } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'SMTP connection refused. Please verify SMTP_HOST and SMTP_PORT are correct.';
          }

          return {
            success: false,
            error: `Error sending email: ${errorMessage}`
          };
        }
      }

      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`
        };
    }
  } catch (error) {
    console.error(`Error executing tool ${toolName}:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Process a message through the AI Agent
 * This is the main entry point that handles the tool calling loop
 */
async function processMessage(options) {
  const {
    userMessage,
    conversationHistory,
    phoneNumber,
    hasMediaAttached,
    mediaType,
    mediaAnalysis,
    isVoice = false,
    replyContext = null
  } = options;

  // CRITICAL: Retrieve user context from MongoDB BEFORE generating prompt
  console.log(`🔍 Looking up user profile for ${phoneNumber}...`);

  let user = null;
  let isAdmin = false;

  try {
    // Extract clean phone number (remove whatsapp: prefix if present)
    const cleanPhone = phoneNumber.replace('whatsapp:', '');

    // Look up user in MongoDB
    user = await User.findOne({ phoneNumber: cleanPhone });

    if (user) {
      console.log(`✅ User found: ${user.alias || user.title || user.fullName || 'Unknown'}`);
      console.log(`   Full Name: ${user.fullName || 'N/A'}`);
      console.log(`   Email: ${user.email || 'Not Set'}`);
      console.log(`   Admin: ${user.isAdmin || false}`);

      isAdmin = user.isAdmin || false;
    } else {
      console.log(`⚠️  User not found in database. Using fallback alias.`);
      // Create a minimal user object for fallback
      user = {
        phoneNumber: cleanPhone,
        alias: 'Estimado Usuario/a',
        fullName: null,
        email: null
      };
    }
  } catch (error) {
    console.error(`❌ Error looking up user:`, error);
    // Use fallback on error
    user = {
      phoneNumber: phoneNumber.replace('whatsapp:', ''),
      alias: 'Estimado Usuario/a',
      fullName: null,
      email: null
    };
  }

  // Build system prompt with user context
  const systemPrompt = buildSystemPrompt(
    user,
    isAdmin,
    hasMediaAttached,
    mediaType,
    mediaAnalysis,
    isVoice,
    replyContext
  );

  // Build messages array for OpenAI
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory
      .filter(msg => msg.content && msg.content.trim())
      .map(msg => ({
        role: msg.role,
        content: msg.content
      }))
  ];

  // Add current user message
  messages.push({
    role: 'user',
    content: userMessage || '(user sent media without text message)'
  });

  console.log(`🤖 Agent processing message from ${user.alias || phoneNumber}`);
  console.log(`   Admin: ${isAdmin}, Media: ${hasMediaAttached}, Type: ${mediaType}`);
  console.log(`   Message: "${userMessage?.substring(0, 100)}..."`);

  // Tool calling loop
  let currentMessages = [...messages];
  let iteration = 0;
  const MAX_ITERATIONS = 5; // Prevent infinite loops

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`   Iteration ${iteration}: Calling GPT-4o...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: currentMessages,
      tools: tools,
      tool_choice: 'auto', // Let GPT decide when to use tools
      temperature: 0.7,
      max_tokens: 1000
    });

    const assistantMessage = response.choices[0].message;
    console.log(`   GPT response: ${assistantMessage.content?.substring(0, 100) || '(tool call)'}`);

    // Add assistant's response to conversation
    currentMessages.push(assistantMessage);

    // Check if GPT wants to call a tool
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      console.log(`   🔧 GPT wants to call ${assistantMessage.tool_calls.length} tool(s)`);

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        // Execute the tool
        const toolResult = await executeTool(toolName, toolArgs, {
          phoneNumber: phoneNumber.replace('whatsapp:', ''),
          user,
          isAdmin,
          mediaAnalysis
        });

        console.log(`   ✅ Tool ${toolName} result:`, JSON.stringify(toolResult, null, 2));

        // Add tool result to conversation
        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        });
      }

      // Continue loop to get GPT's final response
      continue;
    }

    // No tool calls, we have the final response
    console.log(`   ✅ Final response ready`);
    return {
      success: true,
      response: assistantMessage.content,
      toolsCalled: iteration > 1 // Did we call any tools?
    };
  }

  // Max iterations reached
  console.warn(`   ⚠️  Max iterations (${MAX_ITERATIONS}) reached`);
  return {
    success: true,
    response: 'Lo siento, estoy teniendo problemas procesando tu solicitud. ¿Podrías reformularla?',
    error: 'Max iterations reached'
  };
}

/**
 * Send a WhatsApp message via Twilio
 * Utility function for other services
 */
async function sendWhatsAppMessage(to, message, twilioClient) {
  if (!twilioClient) {
    const twilio = require('twilio');
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const result = await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: toNumber,
    body: message
  });

  return result;
}

module.exports = {
  processMessage,
  buildSystemPrompt,
  executeTool,
  sendWhatsAppMessage,
  getPoliteName
};
