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
const integrationService = require("../services/integration.service");

/**
 * GET /api/integrations
 * Get all connected integrations.
 */
exports.getAll = async (req, res) => {
  try {
    const { platform, isActive } = req.query;
    const integrations = await integrationService.getAll({ platform, isActive });
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
    const integration = await integrationService.getById(req.params.id);
    res.json({ success: true, data: integration });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    const integration = await integrationService.connect(req.body, req.user?._id);
    res.json({
      success: true,
      message: `${req.body.platform} connected successfully`,
      data: integration.toJSON(),
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    await integrationService.disconnect(req.params.id, req.user?._id);
    res.json({ success: true, message: "Integration disconnected" });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    const updated = await integrationService.refreshToken(req.params.id);
    res.json({
      success: true,
      message: "Token refreshed successfully",
      data: updated.toJSON(),
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    await integrationService.verifyWebhook(req.params.id, req.user?._id);
    res.json({ success: true, message: "Webhook verified" });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    const integration = await integrationService.updateWebhookConfig(
      req.params.id,
      req.body.webhookConfig
    );
    res.json({ success: true, data: integration });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
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
    await integrationService.remove(req.params.id, req.user?._id);
    res.json({ success: true, message: "Integration removed" });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error("[INTEGRATION] Delete error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
