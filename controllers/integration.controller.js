/**
 * Integration Controller (Legacy CRUD)
 *
 * Generic CRUD over IntegrationAccount records, predating the per-platform
 * OAuth flow. Kept for backwards compatibility with the "Old Manual Token
 * Flow" (see auto-hub-frontend's IntegrationManager.jsx comments).
 *
 * The per-platform OAuth flow (connect/callback/disconnect/refresh/status)
 * lives in platformOAuth.controller.js. Webhook verification/receiving
 * lives in platformWebhook.controller.js. Both were split out of this file
 * to keep the OAuth-only surface separate from the webhook surface that's
 * shared with live WhatsApp messaging.
 *
 *   GET    /api/integrations
 *   GET    /api/integrations/:id
 *   POST   /api/integrations/connect
 *   POST   /api/integrations/:id/disconnect
 *   POST   /api/integrations/:id/refresh
 *   POST   /api/integrations/:id/webhook/verify
 *   PATCH  /api/integrations/:id/webhook-config
 *   DELETE /api/integrations/:id
 */
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");

/**
 * GET /api/integrations
 * Get all connected integrations.
 */
exports.getAll = async (req, res) => {
  try {
    const { platform, isActive } = req.query;
    const query = {};

    if (platform) query.platform = platform;
    if (isActive !== undefined) query.isActive = isActive === "true";

    const integrations = await IntegrationAccount.find(query)
      .select("-accessToken -refreshToken -webhookSecret")
      .sort({ platform: 1, createdAt: -1 })
      .lean();

    res.json({ success: true, data: integrations });
  } catch (err) {
    console.error("[INTEGRATION] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/integrations/:id
 * Get a single integration by ID.
 */
exports.getById = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id)
      .select("-accessToken -refreshToken -webhookSecret")
      .lean();

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    res.json({ success: true, data: integration });
  } catch (err) {
    console.error("[INTEGRATION] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/connect
 * Register a new platform connection with provided tokens.
 *
 * This is called after the OAuth flow completes.
 * For browser-based OAuth, the frontend redirects to the platform's
 * OAuth URL, then the callback sends tokens here.
 */
exports.connect = async (req, res) => {
  try {
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
    } = req.body;

    if (!platform || !accessToken) {
      return res.status(400).json({ success: false, message: "Platform and access token are required" });
    }

    // Check if integration already exists for this platform + user
    let integration = await IntegrationAccount.findOne({
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
      integration = await IntegrationAccount.create({
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

    await integration.save();

    await logAction({
      action: "platform_connected",
      status: "success",
      platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Platform connected: ${platform}${platformEmail ? ` (${platformEmail})` : ""}`,
      userId: req.user?._id,
    });

    res.json({
      success: true,
      message: `${platform} connected successfully`,
      data: integration.toJSON(),
    });
  } catch (err) {
    console.error("[INTEGRATION] Connect error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:id/disconnect
 * Disconnect and deactivate an integration.
 */
exports.disconnect = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    integration.isActive = false;
    integration.isConnected = false;
    await integration.save();

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: integration.platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Platform disconnected: ${integration.platform}`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Integration disconnected" });
  } catch (err) {
    console.error("[INTEGRATION] Disconnect error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:id/refresh
 * Manually trigger a token refresh.
 */
exports.refreshToken = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    if (!integration.refreshToken) {
      return res.status(400).json({ success: false, message: "No refresh token available" });
    }

    const updated = await platformManager.refreshToken(integration.platform, integration);

    res.json({
      success: true,
      message: "Token refreshed successfully",
      data: updated.toJSON(),
    });
  } catch (err) {
    console.error("[INTEGRATION] Refresh error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:id/webhook/verify
 * Verify webhook endpoint for a platform.
 */
exports.verifyWebhook = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    integration.webhookVerified = true;
    integration.webhookLastPing = new Date();
    await integration.save();

    await logAction({
      action: "webhook_verified",
      status: "success",
      platform: integration.platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Webhook verified for ${integration.platform}`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Webhook verified" });
  } catch (err) {
    console.error("[INTEGRATION] Webhook verify error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/integrations/:id/webhook-config
 * Update webhook configuration.
 */
exports.updateWebhookConfig = async (req, res) => {
  try {
    const { webhookConfig } = req.body;

    const integration = await IntegrationAccount.findByIdAndUpdate(
      req.params.id,
      { webhookConfig: webhookConfig || {} },
      { new: true }
    ).select("-accessToken -refreshToken -webhookSecret");

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    res.json({ success: true, data: integration });
  } catch (err) {
    console.error("[INTEGRATION] Webhook config error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/integrations/:id
 * Remove an integration permanently.
 */
exports.remove = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findByIdAndDelete(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: integration.platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Integration removed: ${integration.platform}`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Integration removed" });
  } catch (err) {
    console.error("[INTEGRATION] Delete error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
