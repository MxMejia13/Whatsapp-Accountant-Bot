/**
 * Email Service - SMTP Email Sending with Attachments
 *
 * Uses nodemailer to send emails with optional file attachments.
 * Primarily used for sending invoices and financial documents.
 */

const nodemailer = require('nodemailer');
const { MediaFile } = require('../database/mongodb');
const axios = require('axios');

let transporter = null;

/**
 * Initialize email transporter with SMTP settings
 */
function initEmailService() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('⚠️  Email service not configured (missing SMTP credentials)');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    // Optional: custom email sender name
    from: process.env.EMAIL_FROM || '"WhatsApp Accountant" <bot@mejiafamily.app>'
  });

  console.log('✅ Email service initialized (nodemailer + SMTP)');
  return transporter;
}

/**
 * Send email with optional file attachment
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.body - Email body (plain text or HTML)
 * @param {string} [options.fileId] - Optional MongoDB ObjectId of file to attach
 * @param {boolean} [options.isHtml=false] - Whether body is HTML
 * @returns {Promise<Object>} - Result with success status
 */
async function sendEmail({ to, subject, body, fileId, isHtml = false }) {
  if (!transporter) {
    return {
      success: false,
      error: 'Email service not configured. Please set SMTP credentials in .env'
    };
  }

  try {
    // Validate email
    if (!to || !isValidEmail(to)) {
      return {
        success: false,
        error: `Invalid email address: ${to}`
      };
    }

    // Build email options
    const mailOptions = {
      from: process.env.EMAIL_FROM || '"WhatsApp Accountant" <bot@mejiafamily.app>',
      to: to,
      subject: subject,
      [isHtml ? 'html' : 'text']: body
    };

    // Add attachment if file ID provided
    if (fileId) {
      const file = await MediaFile.findById(fileId);

      if (!file) {
        return {
          success: false,
          error: 'File not found'
        };
      }

      // Download file from S3/R2
      console.log(`📥 Downloading file from S3: ${file.filename}`);
      const response = await axios.get(file.url, { responseType: 'arraybuffer' });
      const fileBuffer = Buffer.from(response.data);

      mailOptions.attachments = [
        {
          filename: file.filename,
          content: fileBuffer,
          contentType: file.mimeType
        }
      ];

      console.log(`📎 Attached file: ${file.filename} (${fileBuffer.length} bytes)`);
    }

    // Send email
    console.log(`📧 Sending email to ${to}...`);
    const info = await transporter.sendMail(mailOptions);

    console.log(`✅ Email sent: ${info.messageId}`);

    return {
      success: true,
      messageId: info.messageId,
      recipient: to,
      subject: subject,
      hasAttachment: !!fileId
    };

  } catch (error) {
    console.error('❌ Email send error:', error);

    return {
      success: false,
      error: error.message || 'Failed to send email'
    };
  }
}

/**
 * Send invoice email with formatted template
 * @param {Object} options - Invoice email options
 * @param {string} options.to - Recipient email
 * @param {Object} options.invoiceData - Invoice summary data
 * @param {string} options.fileId - Invoice file ID
 * @returns {Promise<Object>} - Result
 */
async function sendInvoiceEmail({ to, invoiceData, fileId }) {
  const { vendor, date, total, dueDate, description } = invoiceData;

  const subject = `Invoice from ${vendor} - ${total || 'Amount TBD'}`;

  const body = `
Hello,

You have received an invoice with the following details:

Vendor: ${vendor || 'N/A'}
Date: ${date || 'N/A'}
Total Amount: ${total || 'N/A'}
Due Date: ${dueDate || 'N/A'}

${description ? `Summary: ${description}` : ''}

The invoice document is attached to this email.

Best regards,
WhatsApp Accountant Bot
  `.trim();

  return await sendEmail({
    to,
    subject,
    body,
    fileId,
    isHtml: false
  });
}

/**
 * Validate email address format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Check if email service is configured
 */
function isEmailConfigured() {
  return transporter !== null;
}

module.exports = {
  initEmailService,
  sendEmail,
  sendInvoiceEmail,
  isEmailConfigured
};
