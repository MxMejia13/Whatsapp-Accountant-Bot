/**
 * AWS S3 / Cloudflare R2 Configuration
 *
 * Single source of truth for cloud storage client
 * Works with both AWS S3 and Cloudflare R2 (S3-compatible)
 */

const AWS = require('aws-sdk');

// Validate required environment variables
const requiredEnvVars = [
  'CLOUD_STORAGE_ACCESS_KEY',
  'CLOUD_STORAGE_SECRET_KEY',
  'CLOUD_STORAGE_BUCKET'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.warn(`⚠️  Missing cloud storage configuration: ${missingVars.join(', ')}`);
  console.warn('⚠️  File upload will fail. Please configure environment variables.');
}

// Configure S3 client (works with both S3 and R2)
const s3Client = new AWS.S3({
  endpoint: process.env.CLOUD_STORAGE_ENDPOINT || undefined, // For R2: https://<account-id>.r2.cloudflarestorage.com
  accessKeyId: process.env.CLOUD_STORAGE_ACCESS_KEY,
  secretAccessKey: process.env.CLOUD_STORAGE_SECRET_KEY,
  region: process.env.CLOUD_STORAGE_REGION || 'auto', // 'auto' for R2, 'us-east-1' for S3
  signatureVersion: 'v4',
  s3ForcePathStyle: false // Use virtual-hosted-style URLs
});

// Bucket name
const BUCKET_NAME = process.env.CLOUD_STORAGE_BUCKET || 'whatsapp-bot-media';

// Check if properly configured
const isConfigured = !!(
  process.env.CLOUD_STORAGE_ACCESS_KEY &&
  process.env.CLOUD_STORAGE_SECRET_KEY &&
  process.env.CLOUD_STORAGE_BUCKET
);

if (isConfigured) {
  console.log(`✅ Cloud storage configured: ${BUCKET_NAME}`);
  if (process.env.CLOUD_STORAGE_ENDPOINT) {
    console.log(`   Using Cloudflare R2: ${process.env.CLOUD_STORAGE_ENDPOINT}`);
  } else {
    console.log(`   Using AWS S3: ${process.env.CLOUD_STORAGE_REGION || 'us-east-1'}`);
  }
} else {
  console.warn('⚠️  Cloud storage NOT configured - uploads will fail');
}

module.exports = {
  s3Client,
  BUCKET_NAME,
  isConfigured
};
