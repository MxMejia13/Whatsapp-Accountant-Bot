/**
 * OpenAI Function Calling Tool Definitions
 * Privacy-First Architecture with Smart Search and Permission Protocol
 */

const tools = [
  {
    type: 'function',
    function: {
      name: 'save_file',
      description: 'Save a media file with AI-generated keywords for smart retrieval. Used when user sends a file. The system automatically generates filename, keywords with synonyms, and performs OCR/transcription.',
      parameters: {
        type: 'object',
        properties: {
          custom_name: {
            type: 'string',
            description: 'Custom name if user specified (e.g., "cedula max mejia"). Leave empty if user did not provide a name. The system will generate one automatically.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'SMART SEARCH with query expansion. When searching, ALWAYS expand query with synonyms. Example: "cedula" → "cedula id identificacion documento personal dominicana". Returns user\'s files OR files shared with them. ADMIN sees all files (locked files show metadata only, not content).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query WITH SYNONYMS. CRITICAL: Expand automatically. Examples: "cedula" → "cedula id identificacion documento personal", "passport" → "passport pasaporte travel documento viaje", "receipt" → "receipt factura recibo comprobante"'
          },
          document_type: {
            type: 'string',
            enum: ['passport', 'id_card', 'receipt', 'invoice', 'contract', 'photo', 'audio', 'document', 'all'],
            description: 'Filter by document type. Use "all" if user did not specify.',
            default: 'all'
          },
          limit: {
            type: 'integer',
            description: 'Maximum results',
            default: 5,
            minimum: 1,
            maximum: 20
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_file_access',
      description: 'ADMIN ONLY: Request permission to access a LOCKED file owned by another user. Use when search returns status:"LOCKED". Initiates Permission Handshake: owner gets authorization request, if approved, file is auto-shared and sent to admin.',
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: 'string',
            description: 'MongoDB ObjectId of the locked file (from search results)'
          }
        },
        required: ['file_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_my_stats',
      description: 'Get user\'s file storage statistics with breakdown by type.',
      parameters: {
        type: 'object',
        properties: {
          include_breakdown: {
            type: 'boolean',
            description: 'Include breakdown by document type',
            default: true
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_files',
      description: 'List recently saved files. Privacy: Only shows user\'s own files or files shared with them.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Number of files to show',
            default: 10,
            minimum: 1,
            maximum: 50
          },
          document_type: {
            type: 'string',
            enum: ['passport', 'id_card', 'receipt', 'invoice', 'contract', 'photo', 'audio', 'document', 'all'],
            description: 'Filter by type',
            default: 'all'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description: 'Schedule a future WhatsApp reminder. Parses natural language time expressions (e.g., "mañana a las 9 AM", "en 2 horas", "lunes a las 3 PM"). Can send to the user or to other people.',
      parameters: {
        type: 'object',
        properties: {
          when: {
            type: 'string',
            description: 'Natural language time expression in Spanish or English. Examples: "mañana a las 9 AM", "en 2 horas", "lunes a las 3 PM", "tomorrow at 9 AM"'
          },
          description: {
            type: 'string',
            description: 'The reminder message to send'
          },
          recipients: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'Who should receive the reminder. Can be: "yo"/"me" for the user, or names like "Max", "Vinicio", etc. Default: ["yo"]',
            default: ['yo']
          }
        },
        required: ['when', 'description']
      }
    }
  }
];

module.exports = { tools };
