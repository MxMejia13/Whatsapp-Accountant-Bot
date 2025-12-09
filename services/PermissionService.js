/**
 * Permission Service
 *
 * Handles the "Permission Handshake" workflow:
 * 1. Admin requests access to locked file
 * 2. System sends authorization request to file owner
 * 3. Owner authorizes by replying "AUTHORIZE"
 * 4. System grants access and forwards file to admin
 */

const twilio = require('twilio');
const {
  MediaFile,
  createAccessRequest,
  getPendingAccessRequest,
  grantFileAccess,
  updateAccessRequestStatus
} = require('../database/mongodb');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Request access to a locked file
 * Sends permission request to file owner
 */
async function requestFileAccess(fileId, requesterPhone, requesterTitle) {
  console.log(`🔐 Permission request: ${requesterPhone} wants access to file ${fileId}`);

  // Get file details
  const file = await MediaFile.findById(fileId);
  if (!file) {
    throw new Error('File not found');
  }

  // Check if request already exists
  const existingRequest = await getPendingAccessRequest(fileId, requesterPhone);
  if (existingRequest) {
    return {
      success: false,
      message: 'You already have a pending request for this file. Waiting for owner approval.',
      requestId: existingRequest._id
    };
  }

  // Create access request in database
  const request = await createAccessRequest({
    fileId: fileId,
    requesterPhone: requesterPhone,
    requesterTitle: requesterTitle,
    ownerPhone: file.ownerPhoneNumber,
    ownerTitle: file.ownerTitle,
    filename: file.filename
  });

  console.log(`✅ Access request created: ${request._id}`);

  // Format owner's phone number for WhatsApp
  const ownerWhatsAppNumber = file.ownerPhoneNumber.startsWith('whatsapp:')
    ? file.ownerPhoneNumber
    : `whatsapp:${file.ownerPhoneNumber}`;

  // Send authorization request to file owner
  const message = `⚠️ *SOLICITUD DE ACCESO*

${requesterTitle || requesterPhone} está solicitando acceso a tu archivo:

📄 *Archivo:* ${file.filename}
📁 *Tipo:* ${file.documentType || 'documento'}
📅 *Creado:* ${file.createdAt.toLocaleDateString()}

Para autorizar el acceso, responde:
*AUTHORIZE*

Para rechazar, responde:
*DENY*

Esta solicitud expira en 24 horas.`;

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: ownerWhatsAppNumber,
      body: message
    });

    console.log(`📨 Authorization request sent to ${file.ownerPhoneNumber}`);

    return {
      success: true,
      message: `Permission request sent to ${file.ownerTitle || file.ownerPhoneNumber}. You'll be notified when they respond.`,
      requestId: request._id,
      owner: file.ownerTitle || file.ownerPhoneNumber,
      filename: file.filename
    };
  } catch (error) {
    console.error('Error sending authorization request:', error);
    throw new Error(`Failed to send authorization request: ${error.message}`);
  }
}

/**
 * Handle authorization response from file owner
 * Called when owner replies with "AUTHORIZE" or "DENY"
 */
async function handleAuthorizationResponse(ownerPhone, response, twilioClient) {
  console.log(`🔓 Authorization response from ${ownerPhone}: ${response}`);

  const normalizedResponse = response.toUpperCase().trim();

  if (normalizedResponse !== 'AUTHORIZE' && normalizedResponse !== 'DENY') {
    // Not an authorization response
    return null;
  }

  // Find pending requests for this owner
  const { AccessRequest } = require('../database/mongodb');
  const pendingRequests = await AccessRequest.find({
    ownerPhone: ownerPhone,
    status: 'PENDING'
  }).sort({ requestedAt: -1 });

  if (pendingRequests.length === 0) {
    return {
      success: false,
      message: 'No pending access requests found.'
    };
  }

  // Use the most recent request
  const request = pendingRequests[0];

  if (normalizedResponse === 'AUTHORIZE') {
    // APPROVE ACCESS
    console.log(`✅ Owner approved access to file ${request.fileId}`);

    // Update request status
    await updateAccessRequestStatus(request._id, 'APPROVED');

    // Grant file access
    await grantFileAccess(request.fileId, request.requesterPhone);

    // Get file details
    const file = await MediaFile.findById(request.fileId);

    // Notify requester
    const requesterWhatsAppNumber = request.requesterPhone.startsWith('whatsapp:')
      ? request.requesterPhone
      : `whatsapp:${request.requesterPhone}`;

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: requesterWhatsAppNumber,
      body: `✅ *ACCESO AUTORIZADO*\n\n${request.ownerTitle || request.ownerPhone} ha autorizado tu acceso a:\n📄 ${file.filename}\n\nEl archivo te será enviado ahora.`
    });

    // Send file to requester
    // Note: This will be handled by the webhook after this function returns
    // The webhook will detect the approval and send the file

    // Notify owner
    return {
      success: true,
      action: 'APPROVED',
      message: `✅ Acceso autorizado. ${request.requesterTitle || request.requesterPhone} recibirá el archivo ahora.`,
      file: file,
      requester: {
        phone: request.requesterPhone,
        title: request.requesterTitle
      }
    };

  } else if (normalizedResponse === 'DENY') {
    // DENY ACCESS
    console.log(`❌ Owner denied access to file ${request.fileId}`);

    // Update request status
    await updateAccessRequestStatus(request._id, 'DENIED');

    // Notify requester
    const requesterWhatsAppNumber = request.requesterPhone.startsWith('whatsapp:')
      ? request.requesterPhone
      : `whatsapp:${request.requesterPhone}`;

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: requesterWhatsAppNumber,
      body: `❌ *ACCESO DENEGADO*\n\n${request.ownerTitle || request.ownerPhone} ha rechazado tu solicitud de acceso a:\n📄 ${request.filename}`
    });

    // Notify owner
    return {
      success: true,
      action: 'DENIED',
      message: `❌ Acceso rechazado. ${request.requesterTitle || request.requesterPhone} ha sido notificado.`
    };
  }

  return null;
}

/**
 * Check if message is an authorization response
 */
function isAuthorizationResponse(message) {
  if (!message) return false;
  const normalized = message.toUpperCase().trim();
  return normalized === 'AUTHORIZE' || normalized === 'DENY';
}

module.exports = {
  requestFileAccess,
  handleAuthorizationResponse,
  isAuthorizationResponse
};
