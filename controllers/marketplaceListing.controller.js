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
const MarketplaceListing = require("../models/MarketplaceListing.model");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");

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

/**
 * GET /api/marketplace-leads
 */
exports.getAll = async (req, res) => {
  try {
    const {
      marketplace,
      status,
      orderStatus,
      priority,
      search,
      hasListingId,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (marketplace) query.marketplace = marketplace;
    if (status) query.conversationStatus = status;
    if (orderStatus) query.orderStatus = orderStatus;
    if (priority) query.priority = priority;
    // Additive, opt-in filter for the Marketplace Listings page — restricts
    // results to listing-sourced records only. Omitted (default) preserves
    // today's exact behavior for every other caller.
    if (hasListingId === "true") query.marketplaceListingId = { $ne: null };

    if (search) {
      // Base fields (unchanged — kept for backward compatibility with any
      // order/lead-shaped MarketplaceListing documents/callers).
      const orConditions = [
        { customerName: { $regex: search, $options: "i" } },
        { customerEmail: { $regex: search, $options: "i" } },
        { marketplaceOrderId: { $regex: search, $options: "i" } },
        { productName: { $regex: search, $options: "i" } },
        { trackingNumber: { $regex: search, $options: "i" } },
        // Listing fields — additive, so the Marketplace Listings page's
        // search actually covers what it displays (Listing ID, Marketplace,
        // SKU, Listing Status).
        { marketplaceListingId: { $regex: search, $options: "i" } },
        { productSku: { $regex: search, $options: "i" } },
        { marketplace: { $regex: search, $options: "i" } },
        { listingStatus: { $regex: search, $options: "i" } },
      ];

      // Numeric fields (Price, Quantity): $regex only matches string BSON
      // values, so an exact-value match is added when the search text
      // itself parses as a number.
      const numericValue = Number(search);
      if (search.trim() !== "" && !Number.isNaN(numericValue)) {
        orConditions.push({ price: numericValue });
        orConditions.push({ quantity: numericValue });
      }

      // Date fields (Created Date, Updated Date): matched against the whole
      // calendar day when the search text parses as a valid date, mirroring
      // how the UI displays these fields (date-only, via toLocaleDateString()).
      const parsedDate = new Date(search);
      if (!Number.isNaN(parsedDate.getTime())) {
        const startOfDay = new Date(parsedDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(parsedDate);
        endOfDay.setHours(23, 59, 59, 999);
        orConditions.push({ createdAt: { $gte: startOfDay, $lte: endOfDay } });
        orConditions.push({ updatedAt: { $gte: startOfDay, $lte: endOfDay } });
      }

      query.$or = orConditions;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await MarketplaceListing.countDocuments(query);

    const leads = await MarketplaceListing.find(query)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: leads,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/marketplace-leads/:id
 */
exports.getById = async (req, res) => {
  try {
    const lead = await MarketplaceListing.findById(req.params.id)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .lean();

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/status
 */
exports.updateStatus = async (req, res) => {
  try {
    const { status, marketplace } = req.body;
    const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    // Defense-in-depth: when the caller supplies the record's own
    // `marketplace` value, scope the update to it so a status change can
    // never affect a record belonging to a different marketplace. Omitting
    // it keeps today's exact behavior (id-only lookup) for backward
    // compatibility with any existing caller.
    const filter = marketplace
      ? { _id: req.params.id, marketplace }
      : { _id: req.params.id };

    const lead = await MarketplaceListing.findOneAndUpdate(
      filter,
      { conversationStatus: status },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    await logAction({
      action: "lead_updated",
      status: "success",
      platform: lead.marketplace,
      entityType: "marketplace_lead",
      entityId: lead._id,
      message: `Marketplace listing status updated to ${status}`,
      userId: req.user?._id,
    });

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Update status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/assign
 */
exports.assignUser = async (req, res) => {
  try {
    const { userId } = req.body;

    const lead = await MarketplaceListing.findByIdAndUpdate(
      req.params.id,
      { assignedUser: userId || null },
      { new: true }
    ).populate("assignedUser", "firstName lastName email");

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Assign error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/notes
 */
exports.updateNotes = async (req, res) => {
  try {
    const { notes } = req.body;

    const lead = await MarketplaceListing.findByIdAndUpdate(
      req.params.id,
      { notes },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Update notes error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/order-status
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { orderStatus, shippingStatus, trackingNumber, marketplace } = req.body;

    const updates = {};
    if (orderStatus) updates.orderStatus = orderStatus;
    if (shippingStatus) updates.shippingStatus = shippingStatus;
    if (trackingNumber) updates.trackingNumber = trackingNumber;

    // Same opt-in marketplace-scoping as updateStatus above — additive and
    // backward compatible when `marketplace` isn't supplied.
    const filter = marketplace
      ? { _id: req.params.id, marketplace }
      : { _id: req.params.id };

    const lead = await MarketplaceListing.findOneAndUpdate(
      filter,
      updates,
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    await logAction({
      action: "order_updated",
      status: "success",
      platform: lead.marketplace,
      entityType: "marketplace_lead",
      entityId: lead._id,
      message: `Order ${lead.marketplaceOrderId} status updated`,
      userId: req.user?._id,
    });

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Update order error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/marketplace-leads/:id
 */
exports.remove = async (req, res) => {
  try {
    const lead = await MarketplaceListing.findByIdAndUpdate(
      req.params.id,
      { conversationStatus: "archived" },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    res.json({ success: true, message: "Listing archived" });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Delete error:", err);
    res.status(500).json({ success: false, message: err.message });
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
    const platform = req.query.platform || "ebay";
    const adapter = platformManager.getAdapter(platform);

    if (!adapter.fetchOrders) {
      return res.status(400).json({
        success: false,
        message: `fetchOrders() not implemented for ${platform}`,
      });
    }

    const account = await IntegrationAccount.findOne({ platform, isActive: true }).sort({ createdAt: -1 });
    if (!account) {
      return res.status(404).json({
        success: false,
        message: `No active ${platform} integration found. Connect ${platform} first.`,
      });
    }

    // Auto-refresh token if expired
    if (account.isTokenExpired && account.refreshToken) {
      await platformManager.refreshToken(platform, account);
    }

    const orders = await adapter.fetchOrders(account, req.query);
    res.json({ success: true, data: orders, count: orders.length });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Sync orders error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/marketplace-leads/listings
 * Sync listings from a connected marketplace.
 */
exports.syncListings = async (req, res) => {
  try {
    const platform = req.query.platform || "ebay";
    const adapter = platformManager.getAdapter(platform);

    if (!adapter.fetchListings) {
      return res.status(400).json({
        success: false,
        message: `fetchListings() not implemented for ${platform}`,
      });
    }

    const account = await IntegrationAccount.findOne({ platform, isActive: true }).sort({ createdAt: -1 });
    if (!account) {
      return res.status(404).json({
        success: false,
        message: `No active ${platform} integration found. Connect ${platform} first.`,
      });
    }

    // Auto-refresh token if expired
    if (account.isTokenExpired && account.refreshToken) {
      await platformManager.refreshToken(platform, account);
    }

    const listings = await adapter.fetchListings(account, req.query);
    res.json({ success: true, data: listings, count: listings.length });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Sync listings error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/marketplace-leads/messages
 * Sync messages from a connected marketplace.
 */
exports.syncMessages = async (req, res) => {
  try {
    const platform = req.query.platform || "ebay";
    const adapter = platformManager.getAdapter(platform);

    if (!adapter.fetchMessages) {
      return res.status(400).json({
        success: false,
        message: `fetchMessages() not implemented for ${platform}`,
      });
    }

    const account = await IntegrationAccount.findOne({ platform, isActive: true }).sort({ createdAt: -1 });
    if (!account) {
      return res.status(404).json({
        success: false,
        message: `No active ${platform} integration found. Connect ${platform} first.`,
      });
    }

    // Auto-refresh token if expired
    if (account.isTokenExpired && account.refreshToken) {
      await platformManager.refreshToken(platform, account);
    }

    const conversations = await adapter.fetchMessages(account, req.query);
    emitNewMessageEvents(req, conversations);
    res.json({ success: true, data: conversations, count: conversations.length });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Sync messages error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/marketplace-leads/sync
 * Full sync: orders, listings, and messages from a connected marketplace.
 */
exports.syncAll = async (req, res) => {
  try {
    const platform = req.body.platform || req.query.platform || "ebay";
    const adapter = platformManager.getAdapter(platform);

    if (!adapter.sync) {
      return res.status(400).json({
        success: false,
        message: `sync() not implemented for ${platform}`,
      });
    }

    const account = await IntegrationAccount.findOne({ platform, isActive: true }).sort({ createdAt: -1 });
    if (!account) {
      return res.status(404).json({
        success: false,
        message: `No active ${platform} integration found. Connect ${platform} first.`,
      });
    }

    // Auto-refresh token if expired
    if (account.isTokenExpired && account.refreshToken) {
      await platformManager.refreshToken(platform, account);
    }

    const result = await adapter.sync(account, req.body);
    emitNewMessageEvents(req, result.messages);
    res.json({
      success: true,
      data: result,
      summary: {
        orders: result.orders.length,
        listings: result.listings.length,
        messages: result.messages.length,
      },
    });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Full sync error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

//Ebay conversations function
exports.testEbayConversations = async (req, res) => {
  try {
    console.log("==== 1 ====");

    const IntegrationAccount = require("../models/IntegrationAccount.model");
    const ebayAdapter = require("../services/adapters/ebayAdapter");

    console.log("==== 2 ====");

    const account = await IntegrationAccount.findOne({
      platform: "ebay",
      isConnected: true,
    });

    console.log("==== 3 ====")

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "No connected eBay account found.",
      });
    }

    console.log("==== 4 ====");

    const result = await ebayAdapter.testConversations(account);

    console.log("==== 5 ====");

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    // console.error(err);
    console.error("====== EBAY ERROR =====");
    console.error("Message:", err.message);
    console.error("Stack:", err.stack);

    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Headers:", err.response.headers);
      console.error("Body:", err.response.data);
    }

    return res.status(500).json({
      success: false,
      message: err.message,
      status: err.response?.status || null,
      response: err.response?.data || null,
      stack: err.stack,
    });
  }
};
// exports.testEbayConversations = async (req, res) => {
//     console.log("===== TEST CONTROLLER HIT =====");

//     return res.json({
//         success: true,
//         message: "Controller reached"
//     });
// };
