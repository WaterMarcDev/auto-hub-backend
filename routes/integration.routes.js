const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/integration.controller");
const oauthController = require("../controllers/platformOAuth.controller");
const webhookController = require("../controllers/platformWebhook.controller");

// ═══════════════════════════════════════════════════════════════════════════
// GENERIC PLATFORM-AGNOSTIC ROUTES (must come before /:id to avoid conflicts)
// These routes work with any platform. Adding a new platform = create adapter
// + register with platformManager. No route changes needed.
// ═══════════════════════════════════════════════════════════════════════════

// GET  /api/integrations/:platform/connect  - Initiate OAuth for a platform
router.get("/:platform/connect", auth, oauthController.connectPlatform);

// GET  /api/integrations/:platform/callback  - OAuth callback (no auth — external redirect)
router.get("/:platform/callback", oauthController.handleCallback);

// GET  /api/integrations/:platform/webhook  - Webhook verification (no auth — platform calls this)
router.get("/:platform/webhook", webhookController.verifyWebhookEndpoint);

// POST /api/integrations/:platform/webhook  - Receive webhook events (no auth — platform sends this)
router.post("/:platform/webhook", webhookController.receiveWebhookEndpoint);

// POST /api/integrations/:platform/disconnect  - Disconnect platform
router.post("/:platform/disconnect", auth, oauthController.disconnectPlatform);

// POST /api/integrations/:platform/refresh  - Refresh platform token
router.post("/:platform/refresh", auth, oauthController.refreshPlatformToken);

// GET  /api/integrations/:platform/status  - Get platform connection status
router.get("/:platform/status", auth, oauthController.platformStatus);

// GET /api/integrations/:platform/orders - Fetch marketplace orders
router.get("/:platform/orders", auth, oauthController.fetchOrders);

// GET /api/integrations/:platform/listings - Fetch marketplace listings
router.get("/:platform/listings", auth, oauthController.fetchListings);

// GET /api/integrations/:platform/messages - Fetch marketplace messages
router.get("/:platform/messages", auth, oauthController.fetchMessages);

// POST /api/integrations/:platform/sync - Run full marketplace sync
router.post("/:platform/sync", auth, oauthController.syncPlatform);

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