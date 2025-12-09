/**
 * Invoice Service - Smart Invoice Reporting with Multi-Variable Filtering
 *
 * Handles bulk invoice queries, report generation, and delivery
 * Supports owner filtering, vendor search, privacy enforcement, and dynamic routing
 */

const { MediaFile, resolveNameToPhone, getUserDisplayName, User } = require('../database/mongodb');
const { sendEmail } = require('./EmailService');
const { downloadFile } = require('./CloudStorage');

/**
 * Generate invoice report with advanced filtering and dynamic routing
 * @param {Object} options - Report options
 * @param {string} options.requesterPhone - Who is requesting (for privacy checks)
 * @param {string} options.ownerPhone - User's phone number (privacy filter)
 * @param {string} options.startDate - Start date (ISO string)
 * @param {string} options.endDate - End date (ISO string)
 * @param {string} [options.targetOwnerName] - Filter by specific owner name
 * @param {string} [options.vendorFilter] - Filter by vendor name
 * @param {string} [options.recipientEmail] - Email to send report to
 * @param {string} [options.recipientWhatsapp] - WhatsApp to send report to
 * @param {string} [options.recipientName] - Name to resolve for delivery
 * @param {string} [options.reportFormat] - 'summary_email', 'summary_whatsapp', 'list_only'
 * @param {Object} [options.twilioClient] - Twilio client for WhatsApp delivery
 * @returns {Promise<Object>} - Report result
 */
async function generateInvoiceReport(options) {
  const {
    requesterPhone,
    ownerPhone,
    startDate,
    endDate,
    targetOwnerName,
    vendorFilter,
    recipientEmail,
    recipientWhatsapp,
    recipientName,
    reportFormat = 'summary_email',
    twilioClient
  } = options;

  console.log(`📊 Generating invoice report`);
  console.log(`   Requester: ${requesterPhone}`);
  console.log(`   Date range: ${startDate} to ${endDate}`);
  if (targetOwnerName) console.log(`   Owner filter: ${targetOwnerName}`);
  if (vendorFilter) console.log(`   Vendor filter: ${vendorFilter}`);

  // Parse dates
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return {
      success: false,
      error: 'Invalid date format. Use ISO 8601 format (e.g., "2025-11-01T00:00:00Z")'
    };
  }

  // Ensure end date includes the full day
  end.setHours(23, 59, 59, 999);

  // STEP 1: Resolve target owner if specified
  let targetOwnerPhone = ownerPhone; // Default to requester's own invoices

  if (targetOwnerName) {
    // Handle "Me"/"Yo" as current user
    if (targetOwnerName.toLowerCase() === 'me' || targetOwnerName.toLowerCase() === 'yo') {
      targetOwnerPhone = requesterPhone;
    } else {
      // Resolve name to phone number
      const resolvedPhone = await resolveNameToPhone(targetOwnerName);

      if (!resolvedPhone) {
        return {
          success: false,
          error: `Could not find user: ${targetOwnerName}. Please check the name.`
        };
      }

      targetOwnerPhone = resolvedPhone;
    }
  }

  const targetOwnerDisplay = await getUserDisplayName(targetOwnerPhone);
  console.log(`   Target owner: ${targetOwnerDisplay} (${targetOwnerPhone})`);

  // STEP 2: Build MongoDB query with filters
  const query = {
    ownerPhoneNumber: targetOwnerPhone,
    createdAt: {
      $gte: start,
      $lte: end
    },
    // Filter for high-confidence invoices OR files in invoices/ folder
    $or: [
      { isInvoice: true, invoiceConfidence: { $gte: 0.9 } },
      { s3Key: { $regex: '^invoices/' } }
    ]
  };

  // Add vendor filter if specified
  if (vendorFilter) {
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { 'invoiceSummary.vendor': new RegExp(vendorFilter, 'i') },
        { keywords: new RegExp(vendorFilter, 'i') },
        { description: new RegExp(vendorFilter, 'i') }
      ]
    });
  }

  // Query MongoDB
  const invoices = await MediaFile.find(query)
    .sort({ createdAt: -1 })
    .lean();

  console.log(`   Found ${invoices.length} invoices`);

  if (invoices.length === 0) {
    const filterDesc = vendorFilter ? ` from ${vendorFilter}` : '';
    return {
      success: false,
      error: `No invoices found${filterDesc} in the specified date range`,
      count: 0,
      dateRange: { start: startDate, end: endDate }
    };
  }

  // STEP 3: PRIVACY CHECK - Filter files requester has access to
  const { accessible, locked } = await filterByPrivacy(invoices, requesterPhone);

  console.log(`   Accessible: ${accessible.length}, Locked: ${locked.length}`);

  // STEP 4: Handle locked files
  if (accessible.length === 0 && locked.length > 0) {
    return {
      success: false,
      error: `Found ${locked.length} invoice(s) from ${targetOwnerDisplay}, but you don't have access to them.`,
      locked_count: locked.length,
      owner: targetOwnerDisplay,
      offer_permission_request: true,
      message: `I found ${locked.length} invoices from ${targetOwnerDisplay} in ${formatDateRange(startDate, endDate)}, but they are private. Shall I request permission?`
    };
  }

  if (reportFormat === 'list_only') {
    // Return formatted list without sending
    return {
      success: true,
      mode: 'list_only',
      invoices: formatInvoiceList(accessible),
      count: accessible.length,
      dateRange: { start: startDate, end: endDate },
      owner: targetOwnerDisplay
    };
  }

  // STEP 5: Resolve recipient for delivery
  const destination = await resolveDestination({
    recipientEmail,
    recipientWhatsapp,
    recipientName,
    defaultPhone: requesterPhone
  });

  if (!destination.success) {
    return destination;
  }

  // STEP 6: Generate and deliver report
  if (destination.method === 'email') {
    return await generateAndSendEmailReport(accessible, destination.email, {
      start: startDate,
      end: endDate,
      owner: targetOwnerDisplay,
      vendorFilter
    });
  } else if (destination.method === 'whatsapp') {
    return await generateAndSendWhatsAppReport(accessible, destination.phone, twilioClient, {
      start: startDate,
      end: endDate,
      owner: targetOwnerDisplay,
      vendorFilter
    });
  } else {
    return {
      success: false,
      error: 'Could not determine delivery method. Please specify email or WhatsApp.'
    };
  }
}

/**
 * Filter invoices by privacy - separate accessible and locked files
 */
async function filterByPrivacy(invoices, requesterPhone) {
  const accessible = [];
  const locked = [];

  for (const invoice of invoices) {
    const hasAccess = invoice.ownerPhoneNumber === requesterPhone ||
                     (invoice.sharedWith && invoice.sharedWith.includes(requesterPhone));

    if (hasAccess) {
      accessible.push(invoice);
    } else {
      locked.push({
        _id: invoice._id,
        filename: invoice.filename,
        vendor: invoice.invoiceSummary?.vendor || 'Unknown',
        date: invoice.createdAt,
        status: 'LOCKED'
      });
    }
  }

  return { accessible, locked };
}

/**
 * Resolve destination for report delivery
 */
async function resolveDestination({ recipientEmail, recipientWhatsapp, recipientName, defaultPhone }) {
  // Explicit email
  if (recipientEmail) {
    return {
      success: true,
      method: 'email',
      email: recipientEmail
    };
  }

  // Explicit WhatsApp
  if (recipientWhatsapp) {
    return {
      success: true,
      method: 'whatsapp',
      phone: recipientWhatsapp
    };
  }

  // Resolve name
  if (recipientName) {
    // Handle "Me"/"Yo"
    if (recipientName.toLowerCase() === 'me' || recipientName.toLowerCase() === 'yo') {
      // Use default phone for WhatsApp
      return {
        success: true,
        method: 'whatsapp',
        phone: defaultPhone
      };
    }

    // Resolve name to user
    const resolvedPhone = await resolveNameToPhone(recipientName);

    if (!resolvedPhone) {
      return {
        success: false,
        error: `Could not find recipient: ${recipientName}`
      };
    }

    // Check if user has email in database (future enhancement)
    // For now, use WhatsApp
    return {
      success: true,
      method: 'whatsapp',
      phone: resolvedPhone
    };
  }

  // No recipient specified
  return {
    success: false,
    error: 'No recipient specified. Please provide email address, WhatsApp number, or recipient name.'
  };
}

/**
 * Generate and send email report
 */
async function generateAndSendEmailReport(invoices, targetEmail, metadata) {
  const { start, end, owner, vendorFilter } = metadata;

  // Build summary table
  const summary = buildInvoiceSummary(invoices, { start, end });

  // Calculate totals
  const totals = calculateTotals(invoices);

  // Build subject
  const ownerPart = owner ? ` - ${owner}` : '';
  const vendorPart = vendorFilter ? ` - ${vendorFilter}` : '';
  const subject = `Invoice Report: ${formatDate(start)} to ${formatDate(end)}${ownerPart}${vendorPart}`;

  // Build body
  const body = `
📊 INVOICE REPORT
${owner ? `Owner: ${owner}\n` : ''}Period: ${formatDate(start)} to ${formatDate(end)}
${vendorFilter ? `Vendor Filter: ${vendorFilter}\n` : ''}
${summary}

SUMMARY:
- Total Invoices: ${invoices.length}
- Unique Vendors: ${totals.uniqueVendors}
${totals.totalAmount ? `- Total Amount: ${totals.totalAmount}` : ''}

This report includes ${invoices.length} invoice(s) found in your records.

---
WhatsApp Accountant Bot
  `.trim();

  // Send email
  const result = await sendEmail({
    to: targetEmail,
    subject: subject,
    body: body,
    isHtml: false
  });

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    message: `Invoice report sent to ${targetEmail}`,
    invoiceCount: invoices.length,
    dateRange: { start, end },
    recipient: targetEmail,
    summary: totals,
    owner: owner
  };
}

/**
 * Generate and send WhatsApp report
 */
async function generateAndSendWhatsAppReport(invoices, targetPhone, twilioClient, metadata) {
  const { start, end, owner, vendorFilter } = metadata;

  if (!twilioClient) {
    return {
      success: false,
      error: 'WhatsApp delivery not available (Twilio not configured)'
    };
  }

  // Calculate totals
  const totals = calculateTotals(invoices);

  // Build compact summary for WhatsApp
  const ownerPart = owner ? `de ${owner} ` : '';
  const vendorPart = vendorFilter ? `(${vendorFilter}) ` : '';
  const datePart = formatDateRange(start, end);

  let message = `📊 *Reporte de Facturas*\n\n`;
  message += `${ownerPart}${vendorPart}${datePart}\n\n`;

  // List invoices (max 10 for WhatsApp)
  const displayInvoices = invoices.slice(0, 10);
  displayInvoices.forEach((invoice, index) => {
    const vendor = extractVendor(invoice);
    const amount = extractAmount(invoice);
    const date = formatDate(invoice.createdAt);
    message += `${index + 1}. ${vendor} - ${amount} (${date})\n`;
  });

  if (invoices.length > 10) {
    message += `\n... y ${invoices.length - 10} más\n`;
  }

  message += `\n*Total:* ${invoices.length} facturas`;
  message += `\n*Vendedores:* ${totals.uniqueVendors}`;

  // Format WhatsApp number
  const whatsappNumber = targetPhone.startsWith('whatsapp:')
    ? targetPhone
    : `whatsapp:${targetPhone}`;

  // Send via Twilio
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: whatsappNumber,
    body: message
  });

  const targetDisplay = await getUserDisplayName(targetPhone);

  return {
    success: true,
    message: `Invoice report sent via WhatsApp to ${targetDisplay}`,
    invoiceCount: invoices.length,
    dateRange: { start, end },
    recipient: targetDisplay,
    summary: totals,
    owner: owner
  };
}

/**
 * Format invoice list for display
 */
function formatInvoiceList(invoices) {
  return invoices.map((invoice, index) => ({
    number: index + 1,
    vendor: extractVendor(invoice),
    amount: extractAmount(invoice),
    date: formatDate(invoice.createdAt),
    filename: invoice.filename,
    file_id: invoice._id.toString()
  }));
}

/**
 * Build invoice summary table (text format)
 */
function buildInvoiceSummary(invoices, dateRange) {
  let summary = '';

  summary += 'INVOICES:\n';
  summary += '─'.repeat(70) + '\n';
  summary += 'Date       | Vendor              | Amount        | File\n';
  summary += '─'.repeat(70) + '\n';

  invoices.forEach((invoice) => {
    const date = formatDate(invoice.createdAt);
    const vendor = extractVendor(invoice);
    const amount = extractAmount(invoice);
    const filename = invoice.filename || 'Unknown';

    summary += `${date} | ${padRight(vendor, 19)} | ${padRight(amount, 13)} | ${filename}\n`;
  });

  summary += '─'.repeat(70) + '\n';

  return summary;
}

/**
 * Extract vendor from invoice metadata
 */
function extractVendor(invoice) {
  // Try invoiceSummary first
  if (invoice.invoiceSummary && invoice.invoiceSummary.vendor) {
    return invoice.invoiceSummary.vendor;
  }

  // Try to extract from description
  if (invoice.description) {
    // Look for "from [Vendor]" or "Invoice from [Vendor]"
    const match = invoice.description.match(/(?:from|de|factura\s+de)\s+([A-Za-zÀ-ÿ\s]+?)(?:\s+for|\.|\,|$)/i);
    if (match) {
      return match[1].trim();
    }
  }

  // Try filename
  if (invoice.filename) {
    const parts = invoice.filename.split('-');
    if (parts.length > 1 && parts[0] === 'invoice') {
      return parts[1].replace(/-/g, ' ');
    }
  }

  return 'Unknown';
}

/**
 * Extract amount from invoice metadata
 */
function extractAmount(invoice) {
  // Try invoiceSummary first
  if (invoice.invoiceSummary && invoice.invoiceSummary.total) {
    return invoice.invoiceSummary.total;
  }

  // Try to extract from description or detectedText
  const text = invoice.description || invoice.detectedText || '';

  // Look for common currency patterns
  const patterns = [
    /RD\$\s*[\d,]+\.?\d*/,  // RD$1,500.00
    /US\$\s*[\d,]+\.?\d*/,  // US$100.00
    /\$\s*[\d,]+\.?\d*/,    // $1,500
    /[\d,]+\.?\d*\s*(?:RD|USD|DOP)/  // 1500 RD
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return 'N/A';
}

/**
 * Calculate totals and statistics
 */
function calculateTotals(invoices) {
  const vendors = new Set();

  invoices.forEach(invoice => {
    const vendor = extractVendor(invoice);
    if (vendor !== 'Unknown') {
      vendors.add(vendor);
    }
  });

  return {
    uniqueVendors: vendors.size,
    totalAmount: null // Placeholder for future amount parsing
  };
}

/**
 * Format date for display
 */
function formatDate(dateString) {
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format date range for display
 */
function formatDateRange(start, end) {
  return `${formatDate(start)} to ${formatDate(end)}`;
}

/**
 * Pad string to right with spaces
 */
function padRight(str, length) {
  return (str + ' '.repeat(length)).substring(0, length);
}

/**
 * Query invoices by date range (utility for other services)
 * @param {string} ownerPhone - User's phone number
 * @param {string} startDate - Start date (ISO)
 * @param {string} endDate - End date (ISO)
 * @returns {Promise<Array>} - Array of invoice documents
 */
async function queryInvoicesByDateRange(ownerPhone, startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  return await MediaFile.find({
    ownerPhoneNumber: ownerPhone,
    createdAt: {
      $gte: start,
      $lte: end
    },
    $or: [
      { isInvoice: true, invoiceConfidence: { $gte: 0.9 } },
      { s3Key: { $regex: '^invoices/' } }
    ]
  })
  .sort({ createdAt: -1 })
  .lean();
}

module.exports = {
  generateInvoiceReport,
  queryInvoicesByDateRange,
  extractVendor,
  extractAmount,
  formatInvoiceList
};
