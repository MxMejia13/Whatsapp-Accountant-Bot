/**
 * Cloud Storage Service
 *
 * Handles permanent file storage in AWS S3 or Cloudflare R2
 * Prevents data loss from Railway restarts
 *
 * AWS SDK V3 Implementation with:
 * - Upload class from @aws-sdk/lib-storage for multipart uploads
 * - Command pattern for get/delete operations
 * - Signed URL generation for temporary access
 */

const path = require('path');
const crypto = require('crypto');
const { Upload } = require('@aws-sdk/lib-storage');
const { GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, BUCKET_NAME, isConfigured } = require('../config/s3');

/**
 * Upload a file buffer to cloud storage using AWS SDK v3
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

  try {
    // Validate inputs
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new Error('Invalid fileBuffer - must be a Buffer');
    }

    if (fileBuffer.length === 0) {
      throw new Error('Empty fileBuffer - cannot upload 0 bytes');
    }

    if (!mimeType) {
      throw new Error('Missing mimeType');
    }

    if (!userId) {
      throw new Error('Missing userId');
    }

    // Generate unique key
    const fileExtension = path.extname(originalName) || getExtensionFromMime(mimeType);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 16);
    const timestamp = Date.now();
    const key = `media/${userId}/${timestamp}-${hash}${fileExtension}`;

    console.log(`☁️  Uploading to cloud storage: ${key}`);
    console.log(`   Size: ${fileBuffer.length} bytes`);
    console.log(`   Type: ${mimeType}`);

    // AWS SDK v3: Use Upload class for robust multipart uploads
    const upload = new Upload({
      client: s3Client,
      params: {
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
      }
    });

    // Execute upload and wait for completion
    const result = await upload.done();

    // Construct public URL (for Cloudflare R2 with public bucket)
    // Format: https://<bucket>.<account-id>.r2.cloudflarestorage.com/<key>
    // Or for custom domain: https://<custom-domain>/<key>
    let publicUrl;

    if (result.Location) {
      // S3 provides Location in result
      publicUrl = result.Location;
    } else if (process.env.CLOUD_STORAGE_PUBLIC_URL) {
      // Custom public URL (e.g., R2 custom domain)
      publicUrl = `${process.env.CLOUD_STORAGE_PUBLIC_URL}/${key}`;
    } else {
      // Construct R2 URL from endpoint
      const endpoint = process.env.CLOUD_STORAGE_ENDPOINT || '';
      const bucketUrl = endpoint.replace('https://', `https://${BUCKET_NAME}.`);
      publicUrl = `${bucketUrl}/${key}`;
    }

    console.log(`✅ Uploaded successfully`);
    console.log(`   URL: ${publicUrl}`);
    console.log(`   ETag: ${result.ETag}`);

    return {
      url: publicUrl,
      key: key,
      bucket: BUCKET_NAME,
      size: fileBuffer.length,
      etag: result.ETag
    };

  } catch (error) {
    console.error('❌ Cloud storage upload failed:', error.message);
    console.error('   Stack:', error.stack);
    throw new Error(`Cloud storage upload failed: ${error.message}`);
  }
}

/**
 * Download a file from cloud storage using AWS SDK v3
 * @param {string} key - The S3/R2 key
 * @returns {Promise<Buffer>} File buffer
 */
async function downloadFile(key) {
  console.log(`☁️  Downloading from cloud storage: ${key}`);

  try {
    if (!key || typeof key !== 'string') {
      throw new Error('Invalid key - must be a non-empty string');
    }

    // AWS SDK v3: Use GetObjectCommand
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    const response = await s3Client.send(command);

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    console.log(`✅ Downloaded ${fileBuffer.length} bytes`);
    return fileBuffer;

  } catch (error) {
    console.error('❌ Cloud storage download failed:', error.message);
    console.error('   Stack:', error.stack);
    throw new Error(`Cloud storage download failed: ${error.message}`);
  }
}

/**
 * Delete a file from cloud storage using AWS SDK v3
 * @param {string} key - The S3/R2 key
 * @returns {Promise<void>}
 */
async function deleteFile(key) {
  console.log(`☁️  Deleting from cloud storage: ${key}`);

  try {
    if (!key || typeof key !== 'string') {
      throw new Error('Invalid key - must be a non-empty string');
    }

    // AWS SDK v3: Use DeleteObjectCommand
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    await s3Client.send(command);
    console.log(`✅ Deleted successfully`);

  } catch (error) {
    console.error('❌ Cloud storage deletion failed:', error.message);
    console.error('   Stack:', error.stack);
    throw new Error(`Cloud storage deletion failed: ${error.message}`);
  }
}

/**
 * Generate a signed URL for temporary access using AWS SDK v3
 * @param {string} key - The S3/R2 key
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {Promise<string>} Signed URL
 */
async function getSignedUrlForFile(key, expiresIn = 3600) {
  try {
    if (!key || typeof key !== 'string') {
      throw new Error('Invalid key - must be a non-empty string');
    }

    // AWS SDK v3: Use getSignedUrl from @aws-sdk/s3-request-presigner
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });

    console.log(`🔗 Generated signed URL (expires in ${expiresIn}s)`);
    return signedUrl;

  } catch (error) {
    console.error('❌ Signed URL generation failed:', error.message);
    throw new Error(`Signed URL generation failed: ${error.message}`);
  }
}

/**
 * Get file extension from MIME type
 * @param {string} mimeType - The MIME type
 * @returns {string} File extension with dot (e.g., '.jpg')
 */
function getExtensionFromMime(mimeType) {
  const mimeMap = {
    // Images
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',

    // Audio
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/webm': '.webm',

    // Video
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-msvideo': '.avi',

    // Documents
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/zip': '.zip',
    'application/x-rar-compressed': '.rar',
    'application/x-7z-compressed': '.7z'
  };

  return mimeMap[mimeType] || '';
}

module.exports = {
  uploadFile,
  downloadFile,
  deleteFile,
  getSignedUrl: getSignedUrlForFile, // Export with original name for compatibility
  isConfigured // Re-export from config/s3.js
};
