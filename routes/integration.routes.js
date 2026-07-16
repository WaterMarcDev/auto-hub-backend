const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/integration.controller");

// ═══════════════════════════════════════════════════════════════════════════
// GENERIC PLATFORM-AGNOSTIC ROUTES (must come before /:id to avoid conflicts)
// These routes work with any platform. Adding a new platform = create adapter
// + register with platformManager. No route changes needed.
// ═══════════════════════════════════════════════════════════════════════════

// GET  /api/integrations/:platform/connect  - Initiate OAuth for a platform
router.get("/:platform/connect", auth, controller.connectPlatform);

// GET  /api/integrations/:platform/callback  - OAuth callback (no auth — external redirect)
router.get("/:platform/callback", controller.handleCallback);

// GET  /api/integrations/:platform/webhook  - Webhook verification (no auth — platform calls this)
router.get("/:platform/webhook", controller.verifyWebhookEndpoint);

// POST /api/integrations/:platform/webhook  - Receive webhook events (no auth — platform sends this)
router.post("/:platform/webhook", controller.receiveWebhookEndpoint);

// POST /api/integrations/:platform/disconnect  - Disconnect platform
router.post("/:platform/disconnect", auth, controller.disconnectPlatform);

// POST /api/integrations/:platform/refresh  - Refresh platform token
router.post("/:platform/refresh", auth, controller.refreshPlatformToken);

// GET  /api/integrations/:platform/status  - Get platform connection status
router.get("/:platform/status", auth, controller.platformStatus);

// ─── Standard Integration CRUD Routes ────────────────────────────────────

// GET /api/integrations
router.get("/", auth, controller.getAll);

// GET /api/integrations/connect  (POST)
router.post("/connect", auth, controller.connect);

// GET /api/integrations/:id
router.get("/:id", auth, controller.getById);

// POST /api/integrations/:id/disconnect
router.post("/:id/disconnect", auth, controller.disconnect);

// POST /api/integrations/:id/refresh
router.post("/:id/refresh", auth, controller.refreshToken);

// POST /api/integrations/:id/webhook/verify
router.post("/:id/webhook/verify", auth, controller.verifyWebhook);

// PATCH /api/integrations/:id/webhook-config
router.patch("/:id/webhook-config", auth, controller.updateWebhookConfig);

// DELETE /api/integrations/:id
router.delete("/:id", auth, controller.remove);

module.exports = router;