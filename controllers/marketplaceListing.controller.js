/**
 * Marketplace Listing Controller
 *
 * CRUD operations for marketplace listings (Amazon, eBay) — plus,
 * historically, order/inquiry-shaped records from before the dedicated
 * Orders module (see controllers/order.controller.js) existed.
 *
 * Mirrors the Junk Car Request controller pattern for consistent UI.
 *
 * NOTE: endpoints below are still mounted at /api/marketplace-leads (see
 * server.js) — the URL path is unchanged for backward compatibility; only
 * this file/module's name changed for clarity.
 */
const marketplaceListingService = require("../services/marketplaceListing.service");

/**
 * Emit a real-time `new_message` Socket.io event per synced conversation, so
 * the Unified Inbox can update instantly instead of waiting on its next poll.
 * Mirrors the existing `new_email` pattern in controllers/email.controller.js
 * (same req.app.get("io") accessor, same controller-layer emission point —
 * the eBay adapter itself has no access to `req`/`io`).
 *
 * Purely additive/best-effort: if Socket.io isn't available for any reason,
 * this silently no-ops and never affects the HTTP response.
 *
 * @param {import("express").Request} req
 * @param {Array<Object>} conversations - Conversation documents returned by
 *   an adapter's fetchMessages()/sync() (each entry is the conversation as it
 *   stood immediately after one message was appended).
 */
function emitNewMessageEvents(req, conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) return;

  const io = req.app.get("io");
  if (!io) return;

  for (const conversation of conversations) {
    if (!conversation) continue;
    const lastMsg = conversation.messages?.[conversation.messages.length - 1] || null;

    io.emit("new_message", {
      conversationId: conversation._id,
      message: lastMsg,
      conversation: {
        _id: conversation._id,
        platform: conversation.platform,
        customerName: conversation.customerName,
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: conversation.unreadCount,
        status: conversation.status,
      },
    });
  }
}

function handleError(res, err, label) {
  console.error(`[MARKETPLACE LISTING] ${label}:`, err);
  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }
  return res.status(500).json({ success: false, message: err.message });
}

/**
 * GET /api/marketplace-leads
 */
exports.getAll = async (req, res) => {
  try {
    const result = await marketplaceListingService.getAll(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "Get all error");
  }
};

/**
 * GET /api/marketplace-leads/:id
 */
exports.getById = async (req, res) => {
  try {
    const lead = await marketplaceListingService.getById(req.params.id);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "Get by ID error");
  }
};

/**
 * PATCH /api/marketplace-leads/:id/status
 */
exports.updateStatus = async (req, res) => {
  try {
    const { status, marketplace } = req.body;
    const lead = await marketplaceListingService.updateStatus(req.params.id, status, marketplace, req.user?._id);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "Update status error");
  }
};

/**
 * PATCH /api/marketplace-leads/:id/assign
 */
exports.assignUser = async (req, res) => {
  try {
    const { userId } = req.body;
    const lead = await marketplaceListingService.assignUser(req.params.id, userId);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "Assign error");
  }
};

/**
 * PATCH /api/marketplace-leads/:id/notes
 */
exports.updateNotes = async (req, res) => {
  try {
    const { notes } = req.body;
    const lead = await marketplaceListingService.updateNotes(req.params.id, notes);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "Update notes error");
  }
};

/**
 * PATCH /api/marketplace-leads/:id/order-status
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const lead = await marketplaceListingService.updateOrderStatus(req.params.id, req.body, req.user?._id);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "Update order error");
  }
};

/**
 * DELETE /api/marketplace-leads/:id
 */
exports.remove = async (req, res) => {
  try {
    await marketplaceListingService.remove(req.params.id);
    res.json({ success: true, message: "Listing archived" });
  } catch (err) {
    handleError(res, err, "Delete error");
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MARKETPLACE SYNC ENDPOINTS
// These endpoints are platform-agnostic — they accept a `platform` query param
// (defaulting to "ebay") so Amazon, Google Ads, TikTok, etc. can reuse them.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/marketplace-leads/orders
 * Sync orders from a connected marketplace.
 */
exports.syncOrders = async (req, res) => {
  try {
    const result = await marketplaceListingService.syncOrders(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "Sync orders error");
  }
};

/**
 * GET /api/marketplace-leads/listings
 * Sync listings from a connected marketplace.
 */
exports.syncListings = async (req, res) => {
  try {
    const result = await marketplaceListingService.syncListings(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "Sync listings error");
  }
};

/**
 * GET /api/marketplace-leads/messages
 * Sync messages from a connected marketplace.
 */
exports.syncMessages = async (req, res) => {
  try {
    const result = await marketplaceListingService.syncMessages(req.query);
    emitNewMessageEvents(req, result.data);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "Sync messages error");
  }
};

/**
 * POST /api/marketplace-leads/sync
 * Full sync: orders, listings, and messages from a connected marketplace.
 */
exports.syncAll = async (req, res) => {
  try {
    const { result, summary } = await marketplaceListingService.syncAll(req.body, req.query);
    emitNewMessageEvents(req, result.messages);
    res.json({ success: true, data: result, summary });
  } catch (err) {
    handleError(res, err, "Full sync error");
  }
};

//Ebay conversations function
exports.testEbayConversations = async (req, res) => {
  try {
    const result = await marketplaceListingService.testEbayConversations();
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error("====== EBAY ERROR =====");
    console.error("Message:", err.message);
    console.error("Stack:", err.stack);

    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Headers:", err.response.headers);
      console.error("Body:", err.response.data);
    }

    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message,
      status: err.response?.status || null,
      response: err.response?.data || null,
      stack: err.stack,
    });
  }
};
