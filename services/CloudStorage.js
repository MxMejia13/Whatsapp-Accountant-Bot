/**
 * Cloud Storage Service
 *
 * Handles permanent file storage in AWS S3 or Cloudflare R2
 * Prevents data loss from Railway restarts
 */

const path = require('path');
const crypto = require('crypto');
const { s3Client, BUCKET_NAME, isConfigured } = require('../config/s3');

/**
 * Upload a file buffer to cloud storage
 * @param {Buffer} fileBuffer - The file data
 * @param {Object} metadata - File metadata
 * @returns {Promise<Object>} Upload result with URL and key
 */
async function uploadFile(fileBuffer, metadata) {
  const {
    mimeType,
    originalName,
    userId,
    isForwarded = false
  } = metadata;

  // Generate unique key
  const fileExtension = path.extname(originalName) || getExtensionFromMime(mimeType);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 16);
  const timestamp = Date.now();
  const key = `media/${userId}/${timestamp}-${hash}${fileExtension}`;

  console.log(`☁️  Uploading to cloud storage: ${key}`);

  try {
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      Metadata: {
        userId: userId,
        originalName: originalName || 'unknown',
        uploadedAt: new Date().toISOString(),
        isForwarded: isForwarded.toString()
      }
    };

    const result = await s3Client.upload(uploadParams).promise();

    console.log(`✅ Uploaded successfully: ${result.Location}`);

    return {
      url: result.Location,
      key: key,
      bucket: BUCKET_NAME,
      size: fileBuffer.length,
      etag: result.ETag
    };
  } catch (error) {
    console.error('❌ Cloud storage upload failed:', error);
    throw new Error(`Cloud storage upload failed: ${error.message}`);
  }
}

/**
 * Download a file from cloud storage
 * @param {string} key - The S3/R2 key
 * @returns {Promise<Buffer>} File buffer
 */
async function downloadFile(key) {
  console.log(`☁️  Downloading from cloud storage: ${key}`);

  try {
    const params = {
      Bucket: BUCKET_NAME,
      Key: key
    };

    const result = await s3Client.getObject(params).promise();
    console.log(`✅ Downloaded ${result.Body.length} bytes`);
    return result.Body;
  } catch (error) {
    console.error('❌ Cloud storage download failed:', error);
    throw new Error(`Cloud storage download failed: ${error.message}`);
  }
}

/**
 * Delete a file from cloud storage
 * @param {string} key - The S3/R2 key
 * @returns {Promise<void>}
 */
async function deleteFile(key) {
  console.log(`☁️  Deleting from cloud storage: ${key}`);

  try {
    const params = {
      Bucket: BUCKET_NAME,
      Key: key
    };

    await s3Client.deleteObject(params).promise();
    console.log(`✅ Deleted successfully`);
  } catch (error) {
    console.error('❌ Cloud storage deletion failed:', error);
    throw new Error(`Cloud storage deletion failed: ${error.message}`);
  }
}

/**
 * Generate a signed URL for temporary access
 * @param {string} key - The S3/R2 key
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {string} Signed URL
 */
function getSignedUrl(key, expiresIn = 3600) {
  const params = {
    Bucket: BUCKET_NAME,
    Key: key,
    Expires: expiresIn
  };

  return s3Client.getSignedUrl('getObject', params);
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMime(mimeType) {
  const mimeMap = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
  };

  return mimeMap[mimeType] || '';
}

module.exports = {
  uploadFile,
  downloadFile,
  deleteFile,
  getSignedUrl,
  isConfigured // Re-export from config/s3.js
};
