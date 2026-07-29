const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/marketplaceLead.controller");

// ═══════════════════════════════════════════════════════════════════════════
// MARKETPLACE SYNC ROUTES
// These must come before /:id routes to prevent "orders", "listings", etc.
// from being matched as an :id parameter.
// Platform-agnostic: pass ?platform=ebay (default) or ?platform=amazon
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/marketplace-leads/orders   - Sync orders from marketplace
router.get("/orders", auth, controller.syncOrders);

// GET /api/marketplace-leads/listings  - Sync listings from marketplace
router.get("/listings", auth, controller.syncListings);

// GET /api/marketplace-leads/messages  - Sync messages from marketplace
router.get("/messages", auth, controller.syncMessages);

// POST /api/marketplace-leads/sync     - Full sync (orders + listings + messages)
router.post("/sync", auth, controller.syncAll);

// GET /api/marketplace-leads/ebay/messages-test
router.get("/ebay/messages-test", auth, controller.testEbayConversations);

// Temp
router.get("/ebay/messages-test", auth, (req, res, next) => {
    console.log("===== TEST ROUTE HIT =====");
    next();
}, controller.testEbayConversations);

// ─── Standard CRUD Routes ───────────────────────────────────────────────

// GET /api/marketplace-leads
router.get("/", auth, controller.getAll);

// GET /api/marketplace-leads/:id
router.get("/:id", auth, controller.getById);

// PATCH /api/marketplace-leads/:id/status
router.patch("/:id/status", auth, controller.updateStatus);

// PATCH /api/marketplace-leads/:id/assign
router.patch("/:id/assign", auth, controller.assignUser);

// PATCH /api/marketplace-leads/:id/notes
router.patch("/:id/notes", auth, controller.updateNotes);

// PATCH /api/marketplace-leads/:id/order-status
router.patch("/:id/order-status", auth, controller.updateOrderStatus);

// DELETE /api/marketplace-leads/:id
router.delete("/:id", auth, controller.remove);

module.exports = router;
