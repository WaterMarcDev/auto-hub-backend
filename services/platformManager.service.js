/**
 * Platform Manager Service
 *
 * Central orchestration layer for all platform integrations.
 *
 * The CRM communicates ONLY with the Platform Manager.
 * Each platform has its own adapter that implements a standard interface.
 *
 * Adding a new platform = create one adapter file + register it here.
 * No existing CRM logic needs modification.
 *
 * Adapter Interface:
 *   sendMessage(conversation, text, attachments) -> Promise
 *   fetchMessages(conversation, since) -> Promise
 *   fetchProfile(platformUserId) -> Promise
 *   verifyWebhook(payload, signature) -> boolean
 *   processWebhook(payload) -> Promise
 *   refreshToken(account) -> Promise
 */
const { logAction } = require("./auditLog.service");

// ─── Adapter Registry ──────────────────────────────────────────────────────

const adapters = {};

/**
 * Register a platform adapter.
 *
 * @param {string} platform - Platform name (lowercase)
 * @param {Object} adapter - Adapter implementation
 */
function registerAdapter(platform, adapter) {
  adapters[platform.toLowerCase()] = adapter;
  console.log(`[PLATFORM] Registered adapter: ${platform}`);
}

/**
 * Get the adapter for a specific platform.
 *
 * @param {string} platform - Platform name
 * @returns {Object} Adapter instance
 * @throws {Error} If platform is not supported
 */
function getAdapter(platform) {
  const key = platform.toLowerCase();
  if (!adapters[key]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return adapters[key];
}

/**
 * Check if a platform adapter is registered.
 *
 * @param {string} platform - Platform name
 * @returns {boolean}
 */
function hasAdapter(platform) {
  return !!adapters[platform.toLowerCase()];
}

/**
 * Get all registered platform names.
 *
 * @returns {string[]} Array of platform names
 */
function getRegisteredPlatforms() {
  return Object.keys(adapters);
}

// ─── Message Operations ────────────────────────────────────────────────────

/**
 * Send a message to a customer on a specific platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} conversation - Conversation document
 * @param {string} text - Message text
 * @param {Array} [attachments] - Array of attachment objects
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object>} Result with platformMessageId and status
 */
async function sendMessage(platform, conversation, text, attachments = [], options = {}) {
  const adapter = getAdapter(platform);
  const startTime = Date.now();

  try {
    const result = await adapter.sendMessage(conversation, text, attachments, options);

    await logAction({
      action: "message_sent",
      status: "success",
      platform,
      entityType: "conversation",
      entityId: conversation._id,
      message: `Message sent via ${platform}`,
      durationMs: Date.now() - startTime,
      metadata: { platformMessageId: result.platformMessageId },
    });

    return result;
  } catch (err) {
    await logAction({
      action: "message_failed",
      status: "failure",
      platform,
      entityType: "conversation",
      entityId: conversation._id,
      message: `Failed to send message via ${platform}: ${err.message}`,
      errorMessage: err.message,
      durationMs: Date.now() - startTime,
    });

    throw err;
  }
}

/**
 * Fetch messages from a platform for a conversation.
 *
 * @param {string} platform - Platform name
 * @param {Object} conversation - Conversation document
 * @param {Date} [since] - Only fetch messages since this date
 * @returns {Promise<Array>} Array of message objects
 */
async function fetchMessages(platform, conversation, since = null) {
  const adapter = getAdapter(platform);
  return await adapter.fetchMessages(conversation, since);
}

/**
 * Fetch a customer's profile from a platform.
 *
 * @param {string} platform - Platform name
 * @param {string} platformUserId - Platform user ID
 * @returns {Promise<Object>} Profile object
 */
async function fetchProfile(platform, platformUserId) {
  const adapter = getAdapter(platform);
  return await adapter.fetchProfile(platformUserId);
}

// ─── Webhook Operations ────────────────────────────────────────────────────

/**
 * Verify a webhook signature from a platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} payload - Webhook payload
 * @param {string} signature - Signature header value
 * @returns {boolean} Whether the signature is valid
 */
function verifyWebhook(platform, payload, signature) {
  const adapter = getAdapter(platform);
  return adapter.verifyWebhook(payload, signature);
}

/**
 * Process a webhook payload from a platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} payload - Webhook payload
 * @returns {Promise<Object>} Processing result
 */
async function processWebhook(platform, payload) {
  const adapter = getAdapter(platform);
  const startTime = Date.now();

  try {
    const result = await adapter.processWebhook(payload);

    await logAction({
      action: "webhook_received",
      status: "success",
      platform,
      message: `Webhook processed for ${platform}`,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (err) {
    await logAction({
      action: "webhook_failed",
      status: "failure",
      platform,
      message: `Webhook processing failed for ${platform}: ${err.message}`,
      errorMessage: err.message,
      durationMs: Date.now() - startTime,
    });

    throw err;
  }
}

// ─── Token Operations ──────────────────────────────────────────────────────

/**
 * Refresh an expired access token for a platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} account - IntegrationAccount document
 * @returns {Promise<Object>} Updated account with new tokens
 */
async function refreshToken(platform, account) {
  const adapter = getAdapter(platform);
  const startTime = Date.now();

  try {
    const result = await adapter.refreshToken(account);

    await logAction({
      action: "token_refreshed",
      status: "success",
      platform,
      entityType: "integration_account",
      entityId: account._id,
      message: `Token refreshed for ${platform}`,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (err) {
    await logAction({
      action: "token_expired",
      status: "failure",
      platform,
      entityType: "integration_account",
      entityId: account._id,
      message: `Token refresh failed for ${platform}: ${err.message}`,
      errorMessage: err.message,
      durationMs: Date.now() - startTime,
    });

    throw err;
  }
}
// ─── Connection Operations ─────────────────────────────────────────────────

/**
 * Initiate a connection/authorization flow for a platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} [options] - Platform-specific options
 * @returns {Promise<string>} Authorization URL to redirect the user to
 */
async function connect(platform, options = {}) {
  const adapter = getAdapter(platform);
  return await adapter.connect(options);
}

/**
 * Disconnect and revoke access for a platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} account - IntegrationAccount document
 * @returns {Promise<boolean>}
 */
async function disconnect(platform, account) {
  const adapter = getAdapter(platform);
  const startTime = Date.now();

  try {
    const result = await adapter.disconnect(account);

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform,
      entityType: "integration_account",
      entityId: account._id,
      message: `Platform disconnected: ${platform}`,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (err) {
    await logAction({
      action: "disconnect_failed",
      status: "failure",
      platform,
      entityType: "integration_account",
      entityId: account._id,
      message: `Disconnect failed for ${platform}: ${err.message}`,
      errorMessage: err.message,
      durationMs: Date.now() - startTime,
    });

    throw err;
  }
}

/**
 * Receive and process an incoming webhook event from a platform.
 *
 * @param {string} platform - Platform name
 * @param {Object} payload - Raw webhook payload
 * @returns {Promise<Object>} Processing result
 */
async function receiveWebhook(platform, payload) {
  const adapter = getAdapter(platform);
  return await adapter.receiveWebhook(payload);
}

// ─── Export ────────────────────────────────────────────────────────────────

module.exports = {
  registerAdapter,
  getAdapter,
  hasAdapter,
  getRegisteredPlatforms,
  sendMessage,
  fetchMessages,
  fetchProfile,
  verifyWebhook,
  processWebhook,
  refreshToken,
  connect,
  disconnect,
  receiveWebhook,
};
