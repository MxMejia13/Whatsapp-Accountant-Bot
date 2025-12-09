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
      description: 'Schedule a WhatsApp reminder (one-time or recurring). Supports natural language time and recurrence patterns. IMPORTANT: Gather ALL info (task, time, frequency) in ONE turn before calling.',
      parameters: {
        type: 'object',
        properties: {
          when: {
            type: 'string',
            description: 'Natural language time expression. Examples: "mañana a las 9 AM", "en 2 horas", "lunes a las 3 PM", "10 de diciembre a las 8 AM", "December 10 at 8 AM"'
          },
          description: {
            type: 'string',
            description: 'The reminder message to send (what the user should be reminded about)'
          },
          recipients: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'Who receives the reminder. Default: ["yo"] for current user. Can include names like "Max", "Vinicio"',
            default: ['yo']
          },
          frequency: {
            type: 'string',
            enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'],
            description: 'Recurrence pattern. "once" = one-time (default). "yearly" = birthdays/anniversaries. "monthly" = monthly bills. "weekly" = weekly meetings. "daily" = daily tasks.',
            default: 'once'
          }
        },
        required: ['when', 'description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time. Use this when user asks "what time is it", "what day is today", "what\'s the date", or when you need current time for calculations (age, days until event, etc.).',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description: 'List user\'s documents with optional filtering by type or search query. Returns metadata including filename, description, document type, date, vendor name, and amount.',
      parameters: {
        type: 'object',
        properties: {
          documentType: {
            type: 'string',
            enum: ['passport', 'id_card', 'receipt', 'invoice', 'contract', 'bill', 'photo', 'audio', 'document'],
            description: 'Filter by document type (optional)'
          },
          searchQuery: {
            type: 'string',
            description: 'Text search query to filter documents (optional)'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of documents to return (default: 20)',
            default: 20,
            minimum: 1,
            maximum: 100
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_document',
      description: 'Delete a document from both cloud storage (R2) and database. Requires exact filename. Use this when user explicitly asks to delete a file.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Exact filename of the document to delete (e.g., "receipt-walmart-2024-12-09")'
          }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Smart email dispatch with user alias lookup and file attachment. IMPORTANT: Automatically resolves user aliases to email addresses (e.g., "Vinicio" → looks up email in database). Supports file attachments by filename or R2 key. Use this when user asks to email a document or send information via email.',
      parameters: {
        type: 'object',
        properties: {
          recipientEmail: {
            type: 'string',
            description: 'Recipient: Can be an email address (e.g., "user@example.com") OR a user alias (e.g., "Vinicio", "Max"). If alias is provided, system will automatically look up the user\'s email from the database.'
          },
          subject: {
            type: 'string',
            description: 'Email subject line - be descriptive and professional'
          },
          body: {
            type: 'string',
            description: 'Email body text (supports newlines for formatting). Be clear and helpful.'
          },
          filename_or_key: {
            type: 'string',
            description: 'Optional: File to attach. Can be a filename (e.g., "receipt-walmart-2024-12-09") OR an R2 key (e.g., "media/18091234567/1733766789123-abc123.pdf"). System will automatically find the file and generate a secure 7-day download link.'
          }
        },
        required: ['recipientEmail', 'subject', 'body']
      }
    }
  }
];

module.exports = { tools };
