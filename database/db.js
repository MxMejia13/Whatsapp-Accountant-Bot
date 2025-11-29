const { Pool } = require('pg');

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

/**
 * Execute a query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise} Query result
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

/**
 * Get or create user
 * @param {string} phoneNumber - User's phone number
 * @param {string} name - User's name (optional)
 * @returns {Promise<Object>} User object
 */
async function getOrCreateUser(phoneNumber, name = null) {
  // Check if user exists
  let result = await query(
    'SELECT * FROM users WHERE phone_number = $1',
    [phoneNumber]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  // Create new user
  result = await query(
    'INSERT INTO users (phone_number, name) VALUES ($1, $2) RETURNING *',
    [phoneNumber, name]
  );

  return result.rows[0];
}

/**
 * Save a message
 * @param {Object} messageData - Message data
 * @returns {Promise<Object>} Saved message
 */
async function saveMessage(messageData) {
  const {
    userId,
    phoneNumber,
    messageSid,
    content,
    direction,
    messageType = 'text',
    isForwarded = false
  } = messageData;

  const result = await query(
    `INSERT INTO messages
     (user_id, phone_number, message_sid, content, direction, message_type, is_forwarded)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, phoneNumber, messageSid, content, direction, messageType, isForwarded]
  );

  return result.rows[0];
}

/**
 * Save media file metadata
 * @param {Object} mediaData - Media file data
 * @returns {Promise<Object>} Saved media record
 */
async function saveMediaFile(mediaData) {
  const {
    messageId,
    fileType,
    fileSize,
    fileName,
    fileDescription,
    storageUrl,
    twilioMediaUrl
  } = mediaData;

  const result = await query(
    `INSERT INTO media_files
     (message_id, file_type, file_size, file_name, file_description, storage_url, twilio_media_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [messageId, fileType, fileSize, fileName, fileDescription || null, storageUrl, twilioMediaUrl]
  );

  return result.rows[0];
}

/**
 * Get conversation history for a user
 * @param {string} phoneNumber - User's phone number
 * @param {number} limit - Number of messages to retrieve
 * @returns {Promise<Array>} Array of messages
 */
async function getConversationHistory(phoneNumber, limit = 20) {
  const result = await query(
    `SELECT m.*,
            array_agg(json_build_object(
              'file_type', mf.file_type,
              'storage_url', mf.storage_url,
              'file_name', mf.file_name
            )) FILTER (WHERE mf.id IS NOT NULL) as media
     FROM messages m
     LEFT JOIN media_files mf ON m.id = mf.message_id
     WHERE m.phone_number = $1
     GROUP BY m.id
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [phoneNumber, limit]
  );

  return result.rows.reverse(); // Return in chronological order
}

/**
 * Log usage analytics
 * @param {number} userId - User ID
 * @param {string} action - Action performed
 * @param {Object} details - Additional details
 */
async function logUsage(userId, action, details = {}) {
  try {
    await query(
      'INSERT INTO usage_logs (user_id, action, details) VALUES ($1, $2, $3)',
      [userId, action, JSON.stringify(details)]
    );
  } catch (error) {
    console.error('Error logging usage:', error);
    // Don't throw - logging shouldn't break the app
  }
}

/**
 * Get user statistics
 * @param {number} userId - User ID
 * @returns {Promise<Object>} User statistics
 */
async function getUserStats(userId) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE direction = 'incoming') as messages_sent,
       COUNT(*) FILTER (WHERE direction = 'outgoing') as messages_received,
       COUNT(*) FILTER (WHERE message_type != 'text') as media_count,
       MIN(created_at) as first_message,
       MAX(created_at) as last_message
     FROM messages
     WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0];
}

/**
 * Initialize database (create tables)
 * Call this on first run
 */
async function initializeDatabase() {
  const fs = require('fs');
  const path = require('path');

  try {
    const sqlScript = fs.readFileSync(
      path.join(__dirname, 'init.sql'),
      'utf8'
    );

    await pool.query(sqlScript);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
  }
}

/**
 * Search for media files by type and user
 * @param {string} phoneNumber - User's phone number
 * @param {string} fileType - File type to search for (image, audio, video, document)
 * @param {number} limit - Number of results to return
 * @returns {Promise<Array>} Array of media files
 */
async function searchMediaFiles(phoneNumber, fileType = null, limit = 10) {
  let queryText = `
    SELECT mf.*, m.content as message_content, m.created_at as message_date
    FROM media_files mf
    JOIN messages m ON mf.message_id = m.id
    WHERE m.phone_number = $1
  `;
  const params = [phoneNumber];

  if (fileType) {
    queryText += ` AND mf.file_type LIKE $2`;
    params.push(`${fileType}%`);
  }

  queryText += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await query(queryText, params);
  return result.rows;
}

/**
 * Get media files from a specific date range
 * @param {string} phoneNumber - User's phone number
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date (optional, defaults to now)
 * @returns {Promise<Array>} Array of media files
 */
async function getMediaByDateRange(phoneNumber, startDate, endDate = new Date()) {
  const result = await query(
    `SELECT mf.*, m.content as message_content, m.created_at as message_date
     FROM media_files mf
     JOIN messages m ON mf.message_id = m.id
     WHERE m.phone_number = $1
       AND m.created_at >= $2
       AND m.created_at <= $3
     ORDER BY m.created_at DESC`,
    [phoneNumber, startDate, endDate]
  );
  return result.rows;
}

/**
 * Get the most recent media file of a specific type
 * @param {string} phoneNumber - User's phone number
 * @param {string} fileType - File type (image, audio, video, document)
 * @returns {Promise<Object|null>} Most recent media file or null
 */
async function getLatestMediaFile(phoneNumber, fileType) {
  const result = await query(
    `SELECT mf.*, m.content as message_content, m.created_at as message_date
     FROM media_files mf
     JOIN messages m ON mf.message_id = m.id
     WHERE m.phone_number = $1
       AND mf.file_type LIKE $2
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [phoneNumber, `${fileType}%`]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Search messages by content (text search)
 * @param {string} phoneNumber - User's phone number
 * @param {string} searchTerm - Term to search for
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} Array of messages
 */
async function searchMessages(phoneNumber, searchTerm, limit = 10) {
  const result = await query(
    `SELECT m.*,
            array_agg(json_build_object(
              'file_type', mf.file_type,
              'storage_url', mf.storage_url,
              'file_name', mf.file_name
            )) FILTER (WHERE mf.id IS NOT NULL) as media
     FROM messages m
     LEFT JOIN media_files mf ON m.id = mf.message_id
     WHERE m.phone_number = $1
       AND m.content ILIKE $2
     GROUP BY m.id
     ORDER BY m.created_at DESC
     LIMIT $3`,
    [phoneNumber, `%${searchTerm}%`, limit]
  );
  return result.rows;
}

/**
 * Get all media files for a user
 * @param {string} phoneNumber - User's phone number
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} Array of media files
 */
async function getAllMediaFiles(phoneNumber, limit = 20) {
  const result = await query(
    `SELECT mf.*, m.content as message_content, m.created_at as message_date, m.message_type
     FROM media_files mf
     JOIN messages m ON mf.message_id = m.id
     WHERE m.phone_number = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [phoneNumber, limit]
  );
  return result.rows;
}

/**
 * Search media files by description content (semantic search)
 * @param {string} phoneNumber - User's phone number
 * @param {string} searchTerm - Term to search for in descriptions
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} Array of media files
 */
async function searchMediaByDescription(phoneNumber, searchTerm, limit = 10) {
  // Split search terms and use OR logic - match ANY term, not ALL terms
  // "pasaporte passport" → search for files containing "pasaporte" OR "passport"
  const searchTerms = searchTerm.split(/\s+/).filter(term => term.length > 0);

  // Build dynamic OR conditions for each search term
  const orConditions = [];
  const params = [phoneNumber];
  let paramIndex = 2;

  searchTerms.forEach(term => {
    // For each term, check description, filename, and filename with spaces
    orConditions.push(`(
      mf.file_description ILIKE $${paramIndex}
      OR mf.file_name ILIKE $${paramIndex}
      OR REPLACE(mf.file_name, '-', ' ') ILIKE $${paramIndex}
    )`);
    params.push(`%${term}%`);
    paramIndex++;
  });

  const whereClause = orConditions.length > 0
    ? `AND (${orConditions.join(' OR ')})`
    : '';

  const result = await query(
    `SELECT mf.*, m.content as message_content, m.created_at as message_date, m.message_type
     FROM media_files mf
     JOIN messages m ON mf.message_id = m.id
     WHERE m.phone_number = $1
       ${whereClause}
     ORDER BY m.created_at DESC
     LIMIT $${paramIndex}`,
    [...params, limit]
  );
  return result.rows;
}

/**
 * Delete a media file from database and optionally from disk
 * @param {number} mediaId - ID of the media file to delete
 * @returns {Promise<Object>} Deleted media record
 */
async function deleteMediaFile(mediaId) {
  const result = await query(
    'DELETE FROM media_files WHERE id = $1 RETURNING *',
    [mediaId]
  );
  return result.rows[0];
}

module.exports = {
  query,
  pool,
  getOrCreateUser,
  saveMessage,
  saveMediaFile,
  getConversationHistory,
  logUsage,
  getUserStats,
  initializeDatabase,
  searchMediaFiles,
  getMediaByDateRange,
  getLatestMediaFile,
  searchMessages,
  getAllMediaFiles,
  searchMediaByDescription,
  deleteMediaFile
};
