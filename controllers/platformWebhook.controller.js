/**
 * Platform Webhook Controller
 *
 * Handles inbound webhook verification and event delivery for platforms
 * that push events to us (currently Meta/WhatsApp). This is intentionally
 * kept separate from platformOAuth.controller.js: these two endpoints are
 * the live ingestion path for WhatsApp messages shown in Unified Inbox /
 * Social Media Leads, not part of the Platform Connections OAuth flow, and
 * must not be touched when changing OAuth-only behavior.
 *
 *   GET  /api/integrations/:platform/webhook  - Webhook verification (no auth — platform calls this)
 *   POST /api/integrations/:platform/webhook  - Receive webhook events (no auth — platform sends this)
 */
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");
const { unsupportedPlatformResponse } = require("./integrationShared.util");

/**
 * GET /api/integrations/:platform/webhook
 * Verify a webhook endpoint (platform sends GET to verify).
 * Used by Meta (WhatsApp, Facebook, Instagram) and other platforms.
 */
exports.verifyWebhookEndpoint = async (req, res) => {
  try {
    const { platform } = req.params;

    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    const adapter = platformManager.getAdapter(platform);

    // The adapter's verifyWebhook method handles the platform-specific verification
    const result = adapter.verifyWebhook(req.query);

    if (result.verified) {
      // Update the integration's webhook verification status
      await IntegrationAccount.findOneAndUpdate(
        { platform, isActive: true },
        {
          webhookVerified: true,
          webhookLastPing: new Date(),
        }
      );

      // Return the challenge as plain text (Meta requires this)
      return res.status(200).type("text/plain").send(String(result.challenge));
    }

    // Verification failed
    await logAction({
      action: "webhook_verification_failed",
      status: "failure",
      platform,
      message: `Webhook verification failed for ${platform}`,
      metadata: { query: req.query },
    });

    res.status(403).json({ success: false, message: "Webhook verification failed" });
  } catch (err) {
    console.error(`[INTEGRATION] ${req.params.platform} webhook verify error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:platform/webhook
 * Receive incoming webhook events from a platform.
 * This is where messages, status updates, and other events arrive.
 */
exports.receiveWebhookEndpoint = async (req, res) => {
  try {
    const { platform } = req.params;

    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    // Process the webhook payload through the platform manager
    const result = await platformManager.receiveWebhook(platform, req.body);

    // Acknowledge the webhook (platforms expect a 200 OK quickly)
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[INTEGRATION] ${req.params.platform} webhook receive error:`, err);

    // Always return 200 to prevent platform from retrying failed webhooks
    // that we've already logged internally
    res.json({ success: false, message: err.message });
  }
};
