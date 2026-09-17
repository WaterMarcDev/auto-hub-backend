/**
 * Legacy Integration CRUD business logic. Extracted 1:1 from
 * controllers/integration.controller.js during the clean-architecture
 * migration — see that file's original header comment for context (kept
 * verbatim below).
 *
 * Integration Controller (Legacy CRUD)
 *
 * Generic CRUD over IntegrationAccount records, predating the per-platform
 * OAuth flow. Kept for backwards compatibility with the "Old Manual Token
 * Flow" (see auto-hub-frontend's IntegrationManager.jsx comments).
 */
const integrationAccountRepository = require("../repositories/integrationAccount.repository");
const platformManager = require("./platformManager.service");
const { logAction } = require("./auditLog.service");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getAll({ platform, isActive }) {
  const query = {};
  if (platform) query.platform = platform;
  if (isActive !== undefined) query.isActive = isActive === "true";

  return integrationAccountRepository
    .find(query)
    .select("-accessToken -refreshToken -webhookSecret")
    .sort({ platform: 1, createdAt: -1 })
    .lean();
}

async function getById(id) {
  const integration = await integrationAccountRepository
    .findById(id)
    .select("-accessToken -refreshToken -webhookSecret")
    .lean();

  if (!integration) {
    throw notFoundError("Integration not found");
  }
  return integration;
}

async function connect(body, userId) {
  const {
    platform,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    platformUserId,
    platformPageId,
    platformEmail,
    platformName,
    metadata,
  } = body;

  if (!platform || !accessToken) {
    throw badRequestError("Platform and access token are required");
  }

  // Check if integration already exists for this platform + user
  let integration = await integrationAccountRepository.findOne({
    platform,
    platformUserId: platformUserId || null,
  });

  if (integration) {
    // Update existing
    integration.accessToken = accessToken;
    if (refreshToken) integration.refreshToken = refreshToken;
    if (tokenExpiresAt) integration.tokenExpiresAt = new Date(tokenExpiresAt);
    if (platformPageId) integration.platformPageId = platformPageId;
    if (platformEmail) integration.platformEmail = platformEmail;
    if (platformName) integration.platformName = platformName;
    if (metadata) integration.metadata = { ...integration.metadata, ...metadata };
    integration.isConnected = true;
    integration.isActive = true;
    integration.lastSyncAt = new Date();
    integration.errorCount = 0;
    integration.lastErrorMessage = null;
  } else {
    // Create new
    integration = await integrationAccountRepository.create({
      platform,
      accessToken,
      refreshToken,
      tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
      platformUserId,
      platformPageId,
      platformEmail,
      platformName,
      metadata: metadata || {},
      isActive: true,
      isConnected: true,
      lastSyncAt: new Date(),
    });
  }

  await integrationAccountRepository.save(integration);

  await logAction({
    action: "platform_connected",
    status: "success",
    platform,
    entityType: "integration_account",
    entityId: integration._id,
    message: `Platform connected: ${platform}${platformEmail ? ` (${platformEmail})` : ""}`,
    userId,
  });

  return integration;
}

async function disconnect(id, userId) {
  const integration = await integrationAccountRepository.findById(id);
  if (!integration) {
    throw notFoundError("Integration not found");
  }

  integration.isActive = false;
  integration.isConnected = false;
  await integrationAccountRepository.save(integration);

  await logAction({
    action: "platform_disconnected",
    status: "success",
    platform: integration.platform,
    entityType: "integration_account",
    entityId: integration._id,
    message: `Platform disconnected: ${integration.platform}`,
    userId,
  });
}

async function refreshToken(id) {
  const integration = await integrationAccountRepository.findById(id);
  if (!integration) {
    throw notFoundError("Integration not found");
  }

  if (!integration.refreshToken) {
    throw badRequestError("No refresh token available");
  }

  return platformManager.refreshToken(integration.platform, integration);
}

async function verifyWebhook(id, userId) {
  const integration = await integrationAccountRepository.findById(id);
  if (!integration) {
    throw notFoundError("Integration not found");
  }

  integration.webhookVerified = true;
  integration.webhookLastPing = new Date();
  await integrationAccountRepository.save(integration);

  await logAction({
    action: "webhook_verified",
    status: "success",
    platform: integration.platform,
    entityType: "integration_account",
    entityId: integration._id,
    message: `Webhook verified for ${integration.platform}`,
    userId,
  });
}

async function updateWebhookConfig(id, webhookConfig) {
  const integration = await integrationAccountRepository
    .findByIdAndUpdate(id, { webhookConfig: webhookConfig || {} }, { new: true })
    .select("-accessToken -refreshToken -webhookSecret");

  if (!integration) {
    throw notFoundError("Integration not found");
  }
  return integration;
}

async function remove(id, userId) {
  const integration = await integrationAccountRepository.findByIdAndDelete(id);
  if (!integration) {
    throw notFoundError("Integration not found");
  }

  await logAction({
    action: "platform_disconnected",
    status: "success",
    platform: integration.platform,
    entityType: "integration_account",
    entityId: integration._id,
    message: `Integration removed: ${integration.platform}`,
    userId,
  });
}

module.exports = {
  getAll,
  getById,
  connect,
  disconnect,
  refreshToken,
  verifyWebhook,
  updateWebhookConfig,
  remove,
};
