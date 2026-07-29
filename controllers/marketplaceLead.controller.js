/**
 * Marketplace Lead Controller
 *
 * CRUD operations for marketplace leads (Amazon, eBay orders/inquiries).
 *
 * Mirrors the Junk Car Request controller pattern for consistent UI.
 */
const MarketplaceLead = require("../models/MarketplaceLead.model");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");

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
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (marketplace) query.marketplace = marketplace;
    if (status) query.conversationStatus = status;
    if (orderStatus) query.orderStatus = orderStatus;
    if (priority) query.priority = priority;

    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: "i" } },
        { customerEmail: { $regex: search, $options: "i" } },
        { marketplaceOrderId: { $regex: search, $options: "i" } },
        { productName: { $regex: search, $options: "i" } },
        { trackingNumber: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await MarketplaceLead.countDocuments(query);

    const leads = await MarketplaceLead.find(query)
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
    console.error("[MARKETPLACE LEAD] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/marketplace-leads/:id
 */
exports.getById = async (req, res) => {
  try {
    const lead = await MarketplaceLead.findById(req.params.id)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .lean();

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LEAD] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/status
 */
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const lead = await MarketplaceLead.findByIdAndUpdate(
      req.params.id,
      { conversationStatus: status },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    await logAction({
      action: "lead_updated",
      status: "success",
      platform: lead.marketplace,
      entityType: "marketplace_lead",
      entityId: lead._id,
      message: `Marketplace lead status updated to ${status}`,
      userId: req.user?._id,
    });

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LEAD] Update status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/assign
 */
exports.assignUser = async (req, res) => {
  try {
    const { userId } = req.body;

    const lead = await MarketplaceLead.findByIdAndUpdate(
      req.params.id,
      { assignedUser: userId || null },
      { new: true }
    ).populate("assignedUser", "firstName lastName email");

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LEAD] Assign error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/notes
 */
exports.updateNotes = async (req, res) => {
  try {
    const { notes } = req.body;

    const lead = await MarketplaceLead.findByIdAndUpdate(
      req.params.id,
      { notes },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[MARKETPLACE LEAD] Update notes error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/marketplace-leads/:id/order-status
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { orderStatus, shippingStatus, trackingNumber } = req.body;

    const updates = {};
    if (orderStatus) updates.orderStatus = orderStatus;
    if (shippingStatus) updates.shippingStatus = shippingStatus;
    if (trackingNumber) updates.trackingNumber = trackingNumber;

    const lead = await MarketplaceLead.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
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
    console.error("[MARKETPLACE LEAD] Update order error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/marketplace-leads/:id
 */
exports.remove = async (req, res) => {
  try {
    const lead = await MarketplaceLead.findByIdAndUpdate(
      req.params.id,
      { conversationStatus: "archived" },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, message: "Lead archived" });
  } catch (err) {
    console.error("[MARKETPLACE LEAD] Delete error:", err);
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
    console.error("[MARKETPLACE LEAD] Sync orders error:", err);
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
    console.error("[MARKETPLACE LEAD] Sync listings error:", err);
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
    res.json({ success: true, data: conversations, count: conversations.length });
  } catch (err) {
    console.error("[MARKETPLACE LEAD] Sync messages error:", err);
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
    console.error("[MARKETPLACE LEAD] Full sync error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

//Ebay conversations function
exports.testEbayConversations = async (req, res) => {
  try {
    const IntegrationAccount = require("../models/IntegrationAccount.model");
    const ebayAdapter = require("../services/adapters/ebayAdapter");

    const account = await IntegrationAccount.findOne({
      platform: "ebay",
      isConnected: true,
    });

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "No connected eBay account found.",
      });
    }

    const result = await ebayAdapter.testConversations(account);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message,
      response: err.response?.data || null,
    });
  }
};
