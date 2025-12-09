/**
 * MongoDB Connection and Models
 *
 * Replaces PostgreSQL for media file storage with better full-text search
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Connect to MongoDB
async function connectMongoDB() {
  if (!process.env.MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not configured - media features will be limited');
    return null;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    return mongoose.connection;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * MediaFile Schema
 * Privacy-First: Owner-based access control with permission sharing
 * Smart Search: Keyword expansion and semantic matching
 */
const MediaFileSchema = new Schema({
  // PRIVACY: Owner & Access Control
  ownerPhoneNumber: { type: String, required: true, index: true }, // File owner
  ownerTitle: { type: String }, // Sr. Max, Sr. Jose, etc.
  sharedWith: [{ type: String }], // Phone numbers authorized to access this file
  isPrivate: { type: Boolean, default: true }, // Privacy flag

  // STORAGE: Physical Location (AWS S3 / Cloudflare R2)
  url: { type: String, required: true }, // S3/R2 public/signed URL
  s3Key: { type: String, required: true, unique: true }, // Storage key

  // SMART SEARCH: AI-Generated Metadata with Synonyms
  filename: { type: String, required: true }, // e.g., "cedula-max-mejia.jpg"
  description: { type: String }, // "Dominican ID card for Max Mejia, number 402-2873981-5"
  keywords: [{ type: String }], // ["cedula", "id", "identificacion", "documento", "personal", "dominicana"]
  detectedText: { type: String }, // Full OCR text or Audio Transcript
  documentType: { type: String }, // "passport", "receipt", "contract", "id_card", etc.
  confidence: { type: Number, min: 0, max: 100 }, // AI confidence level (0-100%)

  // FILE METADATA
  originalName: { type: String }, // Original filename from WhatsApp
  mimeType: { type: String, required: true },
  fileSize: { type: Number },

  // CONTEXT
  isForwarded: { type: Boolean, default: false },
  twilioMediaUrl: { type: String },

  // TIMESTAMPS
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

// Create text index for full-text search on description, keywords, and detectedText
MediaFileSchema.index({
  description: 'text',
  keywords: 'text',
  detectedText: 'text',
  filename: 'text',
  documentType: 'text'
}, {
  weights: {
    documentType: 10, // Highest priority
    filename: 8,
    keywords: 5,
    description: 3,
    detectedText: 1
  }
});

// Additional indexes for performance and privacy
MediaFileSchema.index({ ownerPhoneNumber: 1, createdAt: -1 }); // Fast owner lookup
MediaFileSchema.index({ documentType: 1 });
MediaFileSchema.index({ isForwarded: 1 });
MediaFileSchema.index({ sharedWith: 1 }); // Fast permission checks
MediaFileSchema.index({ keywords: 1 }); // Fast keyword search

// Auto-update updatedAt timestamp
MediaFileSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * User Schema (for user management)
 */
const UserSchema = new Schema({
  phoneNumber: { type: String, required: true, unique: true, index: true },
  name: { type: String },
  title: { type: String }, // Sr. Max, Sr. Jose, etc.
  isAdmin: { type: Boolean, default: false }, // System admin for global search

  // Stats
  totalFiles: { type: Number, default: 0 },
  totalMessages: { type: Number, default: 0 },

  // Timestamps
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

// Update lastActive on each interaction
UserSchema.methods.updateLastActive = function() {
  this.lastActive = new Date();
  return this.save();
};

/**
 * AccessRequest Schema
 * For the "Permission Handshake" workflow when Admin requests locked files
 */
const AccessRequestSchema = new Schema({
  fileId: { type: Schema.Types.ObjectId, ref: 'MediaFile', required: true, index: true },
  requesterPhone: { type: String, required: true, index: true },
  requesterTitle: { type: String },
  ownerPhone: { type: String, required: true, index: true },
  ownerTitle: { type: String },

  // File info for context
  filename: { type: String },

  // Status tracking
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'],
    default: 'PENDING',
    index: true
  },

  // Timestamps
  requestedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) } // 24h expiry
});

// Auto-expire old pending requests
AccessRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * PendingConfirmation Schema
 * Temporary storage for media awaiting user confirmation
 */
const PendingConfirmationSchema = new Schema({
  userId: { type: String, required: true, index: true },
  phoneNumber: { type: String, required: true },

  // Media Data (temporary, before cloud upload)
  mediaBuffer: { type: Buffer },
  mimeType: { type: String },

  // AI Analysis Results
  suggestedFilename: { type: String },
  suggestedDescription: { type: String },
  suggestedKeywords: [{ type: String }],
  documentType: { type: String },
  confidence: { type: Number },
  detectedText: { type: String },

  // Context
  userMessage: { type: String }, // What user said when sending the file
  isForwarded: { type: Boolean },

  // Status
  status: { type: String, enum: ['PENDING', 'CONFIRMED', 'REJECTED'], default: 'PENDING' },

  // Timestamps
  createdAt: { type: Date, default: Date.now, expires: '1h' } // Auto-delete after 1 hour
});

PendingConfirmationSchema.index({ userId: 1, status: 1 });

/**
 * ConversationHistory Schema
 * Stores message history for context preservation
 */
const ConversationHistorySchema = new Schema({
  phoneNumber: { type: String, required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true, expires: '7d' } // Auto-delete after 7 days
});

// Compound index for efficient queries
ConversationHistorySchema.index({ phoneNumber: 1, createdAt: -1 });

// ============================================================================
// MODELS
// ============================================================================

const MediaFile = mongoose.model('MediaFile', MediaFileSchema);
const User = mongoose.model('User', UserSchema);
const AccessRequest = mongoose.model('AccessRequest', AccessRequestSchema);
const PendingConfirmation = mongoose.model('PendingConfirmation', PendingConfirmationSchema);
const ConversationHistory = mongoose.model('ConversationHistory', ConversationHistorySchema);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Save a media file with metadata
 */
async function saveMediaFile(data) {
  const mediaFile = new MediaFile(data);
  await mediaFile.save();

  // Update user's file count
  await User.findOneAndUpdate(
    { phoneNumber: data.userId },
    { $inc: { totalFiles: 1 } }
  );

  return mediaFile;
}

/**
 * Search media files with PRIVACY enforcement
 * @param {string} requesterPhone - Who is searching
 * @param {string} searchQuery - What to search for
 * @param {boolean} isAdmin - Is requester an admin?
 * @param {number} limit - Max results
 * @returns {Promise<Array>} - Files (may include LOCKED entries for admin)
 */
async function searchMediaFiles(requesterPhone, searchQuery, isAdmin = false, limit = 10) {
  let query;

  if (isAdmin) {
    // Admin can search ALL files
    query = {
      $text: { $search: searchQuery }
    };
  } else {
    // Regular users: Only files they own OR are shared with them
    query = {
      $text: { $search: searchQuery },
      $or: [
        { ownerPhoneNumber: requesterPhone },
        { sharedWith: requesterPhone }
      ]
    };
  }

  const results = await MediaFile.find(query, {
    score: { $meta: 'textScore' }
  })
  .sort({ score: { $meta: 'textScore' } })
  .limit(limit)
  .lean();

  // For admin: Mark locked files
  if (isAdmin) {
    return results.map(file => {
      const hasAccess = file.ownerPhoneNumber === requesterPhone ||
                       (file.sharedWith && file.sharedWith.includes(requesterPhone));

      if (!hasAccess) {
        // Return LOCKED metadata only
        return {
          _id: file._id,
          filename: file.filename,
          owner: file.ownerTitle || file.ownerPhoneNumber,
          documentType: file.documentType,
          createdAt: file.createdAt,
          status: 'LOCKED',
          message: 'Permission required to access this file'
        };
      }

      return file; // Full access
    });
  }

  return results;
}

/**
 * Get media files by document type
 */
async function getMediaByType(userId, documentType, limit = 10) {
  return await MediaFile.find({ userId, documentType })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Get recent media files
 */
async function getRecentMedia(userId, limit = 20) {
  return await MediaFile.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Get or create user
 */
async function getOrCreateUser(phoneNumber, name = null, title = null) {
  let user = await User.findOne({ phoneNumber });

  if (!user) {
    user = new User({ phoneNumber, name, title });
    await user.save();
    console.log(`✅ Created new user: ${phoneNumber}`);
  } else if (name || title) {
    // Update name/title if provided
    if (name) user.name = name;
    if (title) user.title = title;
    await user.save();
  }

  await user.updateLastActive();
  return user;
}

/**
 * Get user stats
 */
async function getUserStats(phoneNumber) {
  const user = await User.findOne({ phoneNumber });
  if (!user) return null;

  const fileBreakdown = await MediaFile.aggregate([
    { $match: { userId: phoneNumber } },
    { $group: {
      _id: '$documentType',
      count: { $sum: 1 }
    }}
  ]);

  return {
    totalFiles: user.totalFiles,
    totalMessages: user.totalMessages,
    breakdown: fileBreakdown.reduce((acc, item) => {
      acc[item._id || 'other'] = item.count;
      return acc;
    }, {})
  };
}

/**
 * Check if user is admin
 */
async function isUserAdmin(phoneNumber) {
  const user = await User.findOne({ phoneNumber });
  return user ? user.isAdmin : false;
}

/**
 * Verify if user has access to a file
 */
async function verifyFileAccess(phoneNumber, fileId) {
  const file = await MediaFile.findById(fileId);
  if (!file) return false;

  // Owner always has access
  if (file.ownerPhoneNumber === phoneNumber) return true;

  // Check if shared
  if (file.sharedWith && file.sharedWith.includes(phoneNumber)) return true;

  // Check if admin
  const isAdmin = await isUserAdmin(phoneNumber);
  if (isAdmin) return true; // Admin can access (for viewing metadata, not downloading without permission)

  return false;
}

/**
 * Grant access to a file
 */
async function grantFileAccess(fileId, phoneNumber) {
  const file = await MediaFile.findById(fileId);
  if (!file) throw new Error('File not found');

  if (!file.sharedWith) file.sharedWith = [];

  if (!file.sharedWith.includes(phoneNumber)) {
    file.sharedWith.push(phoneNumber);
    await file.save();
    console.log(`✅ Granted access to ${phoneNumber} for file ${fileId}`);
  }

  return file;
}

/**
 * Create access request
 */
async function createAccessRequest(data) {
  const request = new AccessRequest(data);
  await request.save();
  return request;
}

/**
 * Get pending access request
 */
async function getPendingAccessRequest(fileId, requesterPhone) {
  return await AccessRequest.findOne({
    fileId,
    requesterPhone,
    status: 'PENDING'
  });
}

/**
 * Update access request status
 */
async function updateAccessRequestStatus(requestId, status) {
  const request = await AccessRequest.findById(requestId);
  if (!request) throw new Error('Access request not found');

  request.status = status;
  request.respondedAt = new Date();
  await request.save();

  return request;
}

/**
 * Save a message to conversation history
 * @param {string} phoneNumber - User's phone number
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - Message content
 */
async function saveMessageToHistory(phoneNumber, role, content) {
  if (!content || !content.trim()) {
    return; // Skip empty messages
  }

  const message = new ConversationHistory({
    phoneNumber: phoneNumber.replace('whatsapp:', ''), // Clean phone number
    role,
    content: content.trim()
  });

  await message.save();
}

/**
 * Get conversation history for a user
 * @param {string} phoneNumber - User's phone number
 * @param {number} limit - Number of messages to retrieve (default: 10 = ~5 exchanges)
 * @returns {Promise<Array>} - Array of messages {role, content}
 */
async function getConversationHistory(phoneNumber, limit = 10) {
  const cleanPhone = phoneNumber.replace('whatsapp:', '');

  const messages = await ConversationHistory.find({ phoneNumber: cleanPhone })
    .sort({ createdAt: -1 }) // Most recent first
    .limit(limit)
    .select('role content -_id') // Only return role and content
    .lean();

  // Reverse to get chronological order (oldest first)
  return messages.reverse();
}

/**
 * Clear conversation history for a user (optional - for privacy)
 * @param {string} phoneNumber - User's phone number
 */
async function clearConversationHistory(phoneNumber) {
  const cleanPhone = phoneNumber.replace('whatsapp:', '');
  await ConversationHistory.deleteMany({ phoneNumber: cleanPhone });
}

module.exports = {
  connectMongoDB,
  MediaFile,
  User,
  AccessRequest,
  PendingConfirmation,
  saveMediaFile,
  searchMediaFiles,
  getMediaByType,
  getRecentMedia,
  getOrCreateUser,
  getUserStats,
  isUserAdmin,
  verifyFileAccess,
  grantFileAccess,
  createAccessRequest,
  getPendingAccessRequest,
  updateAccessRequestStatus,
  saveMessageToHistory,
  getConversationHistory,
  clearConversationHistory
};
