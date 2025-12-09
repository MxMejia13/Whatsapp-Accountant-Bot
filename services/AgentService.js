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
 * Build the system prompt with user context
 */
function buildSystemPrompt(user, isAdmin, hasMediaAttached, mediaType, mediaAnalysis) {
  // User context with alias, full name, and email
  let userContext = '';
  if (user) {
    const alias = user.alias || user.title || 'Estimado Usuario/a';
    const fullName = user.fullName || user.name || '';
    const email = user.email || 'Not Set';

    userContext = `\n\n👤 USER CONTEXT: You are speaking with ${alias}${fullName ? ` (${fullName})` : ''}. Address the user respectfully using their alias. ${email !== 'Not Set' ? `Their email is ${email}.` : ''} Never ask the user for their name.`;
  } else {
    userContext = '\n\n👤 USER CONTEXT: You are speaking with Estimado Usuario/a. Address the user respectfully.';
  }

  const adminContext = isAdmin
    ? `\n\n🔐 ADMIN PRIVILEGES: You have admin access. You can search ALL files in the system. Files you don't own will show as LOCKED with metadata only. Use \`request_file_access\` to request permission from the owner.`
    : '';

  const mediaContext = hasMediaAttached && mediaAnalysis
    ? `\n\n📎 MEDIA CONTEXT: The user sent a ${mediaType} file. AI Analysis:\n${mediaAnalysis.description || 'No description'}\nKeywords: ${mediaAnalysis.keywords ? mediaAnalysis.keywords.join(', ') : 'none'}\nDocument Type: ${mediaAnalysis.documentType || 'unknown'}\nConfidence: ${mediaAnalysis.confidence || 0}%`
    : '';

  return `You are a Privacy-First Intelligent WhatsApp Accountant Assistant. You help users store, search, and retrieve their personal documents with AI-powered intelligence.${userContext}${adminContext}${mediaContext}

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

6. **\`schedule_reminder\`** - Schedule WhatsApp reminders
   - Use when: User wants to schedule a future message/reminder
   - Parameters: when (natural language), description, recipients (optional)
   - Examples: "Recuérdame mañana a las 9 AM llamar al contador", "Program un reminder en 2 horas"
   - Supports Spanish and English time expressions

## EXAMPLES:

**Example 1: Smart Save**
User: [sends image of Dominican ID]
System: [Auto-analyzed: "Dominican ID card, keywords: cedula id identificacion..."]
You: Call \`save_file\` (no custom_name)
Response: "✅ Cédula guardada, ${user.alias}! Generé palabras clave inteligentes para búsqueda rápida."

**Example 2: Smart Search**
User: "Enviame mi cedula"
You: Call \`search_files\` with query "cedula id identificacion documento personal dominicana"
Response: [If found] "📎 Aquí está tu cédula, ${user.alias}!"

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

## REMEMBER:
- Be proactive and intelligent
- ALWAYS expand search queries with synonyms
- Respect privacy boundaries
- Explain permission workflow clearly to admins
- Be conversational and helpful
- Default language: SPANISH

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
        const { when, description, recipients } = args;

        // Parse natural language time
        const executionTime = parseNaturalTime(when);

        // Default recipients to current user
        const recipientList = recipients && recipients.length > 0
          ? recipients
          : ['yo'];

        console.log(`📅 Scheduling reminder for: ${executionTime.toISOString()}`);
        console.log(`   Description: ${description}`);
        console.log(`   Recipients: ${recipientList.join(', ')}`);

        try {
          const result = await scheduleReminder(
            executionTime,
            recipientList,
            description,
            phoneNumber.replace('whatsapp:', '')
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

          return {
            success: true,
            message: `Reminder scheduled successfully`,
            scheduled_for: result.scheduledFor,
            scheduled_for_readable: timeString,
            recipient_count: result.recipientCount,
            recipients: result.recipients,
            job_id: result.jobId,
            description: description
          };

        } catch (error) {
          console.error('Error scheduling reminder:', error);
          return {
            success: false,
            error: `Failed to schedule: ${error.message}`
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
    mediaAnalysis
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
    mediaAnalysis
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
  sendWhatsAppMessage
};
