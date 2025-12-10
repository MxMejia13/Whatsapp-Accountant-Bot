/**
 * Conversation Context Manager
 *
 * Maintains short-term conversation context to link related messages
 * (e.g., image + follow-up text message asking about the image)
 */

// Store recent messages per user (in-memory)
// Key: phoneNumber, Value: { messages: [], lastActivity: timestamp }
const userContexts = new Map();

// Context expires after 30 seconds of inactivity
const CONTEXT_TIMEOUT_MS = 30000;

/**
 * Add a message to user's context
 */
function addMessage(phoneNumber, message) {
  const now = Date.now();

  if (!userContexts.has(phoneNumber)) {
    userContexts.set(phoneNumber, {
      messages: [],
      lastActivity: now
    });
  }

  const context = userContexts.get(phoneNumber);

  // Clean old messages (older than 30 seconds)
  context.messages = context.messages.filter(
    msg => (now - msg.timestamp) < CONTEXT_TIMEOUT_MS
  );

  // Add new message
  context.messages.push({
    ...message,
    timestamp: now
  });

  context.lastActivity = now;

  // Keep only last 5 messages to prevent memory bloat
  if (context.messages.length > 5) {
    context.messages.shift();
  }
}

/**
 * Get recent media message (within last 30 seconds)
 * Returns the most recent media attachment if exists
 */
function getRecentMedia(phoneNumber) {
  if (!userContexts.has(phoneNumber)) {
    return null;
  }

  const context = userContexts.get(phoneNumber);
  const now = Date.now();

  // Find most recent media message (image, audio, document)
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];

    // Check if message is recent enough
    if ((now - msg.timestamp) > CONTEXT_TIMEOUT_MS) {
      continue;
    }

    // Check if it has media
    if (msg.hasMedia && msg.mediaAnalysis) {
      return {
        analysis: msg.mediaAnalysis,
        mimeType: msg.mimeType,
        mediaType: msg.mediaType,
        s3Key: msg.s3Key,
        filename: msg.filename,
        timestamp: msg.timestamp,
        ageSeconds: Math.floor((now - msg.timestamp) / 1000)
      };
    }
  }

  return null;
}

/**
 * Get full conversation context for a user
 */
function getContext(phoneNumber) {
  if (!userContexts.has(phoneNumber)) {
    return { messages: [] };
  }

  const context = userContexts.get(phoneNumber);
  const now = Date.now();

  // Clean old messages
  context.messages = context.messages.filter(
    msg => (now - msg.timestamp) < CONTEXT_TIMEOUT_MS
  );

  return {
    messages: context.messages,
    lastActivity: context.lastActivity,
    pendingExtraction: context.pendingExtraction || null
  };
}

/**
 * Store pending extraction data (when clarification needed)
 */
function setPendingExtraction(phoneNumber, extractionData) {
  if (!userContexts.has(phoneNumber)) {
    userContexts.set(phoneNumber, {
      messages: [],
      lastActivity: Date.now()
    });
  }

  const context = userContexts.get(phoneNumber);
  context.pendingExtraction = {
    ...extractionData,
    timestamp: Date.now()
  };
  context.lastActivity = Date.now();
}

/**
 * Get pending extraction data (if exists and not expired)
 */
function getPendingExtraction(phoneNumber) {
  if (!userContexts.has(phoneNumber)) {
    return null;
  }

  const context = userContexts.get(phoneNumber);
  if (!context.pendingExtraction) {
    return null;
  }

  const now = Date.now();
  // Check if extraction is still fresh (within timeout)
  if ((now - context.pendingExtraction.timestamp) > CONTEXT_TIMEOUT_MS) {
    // Expired
    context.pendingExtraction = null;
    return null;
  }

  return context.pendingExtraction;
}

/**
 * Clear pending extraction
 */
function clearPendingExtraction(phoneNumber) {
  if (userContexts.has(phoneNumber)) {
    const context = userContexts.get(phoneNumber);
    context.pendingExtraction = null;
  }
}

/**
 * Clear context for a user
 */
function clearContext(phoneNumber) {
  userContexts.delete(phoneNumber);
}

/**
 * Cleanup old contexts (run periodically)
 */
function cleanupOldContexts() {
  const now = Date.now();

  for (const [phoneNumber, context] of userContexts.entries()) {
    if ((now - context.lastActivity) > CONTEXT_TIMEOUT_MS * 2) {
      userContexts.delete(phoneNumber);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupOldContexts, 60000);

module.exports = {
  addMessage,
  getRecentMedia,
  getContext,
  clearContext,
  setPendingExtraction,
  getPendingExtraction,
  clearPendingExtraction
};
