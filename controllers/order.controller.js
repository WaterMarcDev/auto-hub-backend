/**
 * Order Controller
 *
 * Read/update API for the dedicated Orders module. Backed by the `Order`
 * collection (models/Order.model.js), which is completely separate from
 * `MarketplaceLead` — the Marketplace page's own model. Orders are created
 * exclusively by marketplace adapters during sync (see
 * services/adapters/ebayAdapter.js#_upsertOrder); this controller only
 * reads and updates status-related fields.
 *
 * Mirrors the response shape/style of controllers/marketplaceLead.controller.js.
 */
const Order = require("../models/Order.model");
const { logAction } = require("../services/auditLog.service");

/**
 * GET /api/orders
 */
exports.getAll = async (req, res) => {
  try {
    const {
      platform,
      status,
      paymentStatus,
      shippingStatus,
      customerId,
      conversationId,
      dateFrom,
      dateTo,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (platform) query.platform = platform;
    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (shippingStatus) query.shippingStatus = shippingStatus;
    if (customerId) query.customerId = customerId;
    if (conversationId) query.conversationId = conversationId;

    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }

    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: "i" } },
        { legacyOrderId: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
        { buyerUsername: { $regex: search, $options: "i" } },
        { buyerEmail: { $regex: search, $options: "i" } },
        { "items.title": { $regex: search, $options: "i" } },
        { "items.sku": { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Order.countDocuments(query);

    const orders = await Order.find(query)
      .populate("customerId", "firstName lastName email mobileNo")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Lightweight, non-persisted summary for the list view — avoids storing
    // redundant/potentially-stale data alongside `items[]`.
    const data = orders.map((order) => ({
      ...order,
      customerEmail: order.buyerEmail || null,
      itemsSummary:
        order.items && order.items.length > 1
          ? `${order.items[0]?.title || "Item"} +${order.items.length - 1} more`
          : order.items?.[0]?.title || null,
    }));

    res.json({
      success: true,
      data,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("[ORDER] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/orders/:id
 */
exports.getById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("customerId", "firstName lastName email mobileNo idProofType")
      .populate("conversationId", "platform status lastMessageAt")
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({
      success: true,
      data: { ...order, customerEmail: order.buyerEmail || null },
    });
  } catch (err) {
    console.error("[ORDER] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/orders/:id/status
 *
 * Accepts any of paymentStatus/shippingStatus/trackingNumber. When the
 * caller supplies `platform` in the body, the update is scoped to
 * {_id, platform} for defense-in-depth (mirrors the same opt-in-stricter
 * pattern used by controllers/marketplaceLead.controller.js's status
 * endpoints); when omitted, falls back to id-only lookup.
 */
exports.updateStatus = async (req, res) => {
  try {
    const { paymentStatus, shippingStatus, trackingNumber, platform } = req.body;

    const updates = {};
    if (paymentStatus) updates.paymentStatus = paymentStatus;
    if (shippingStatus) updates.shippingStatus = shippingStatus;
    if (trackingNumber) updates.trackingNumber = trackingNumber;

    const filter = platform
      ? { _id: req.params.id, platform }
      : { _id: req.params.id };

    const order = await Order.findOneAndUpdate(filter, updates, { new: true });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    await logAction({
      action: "order_updated",
      status: "success",
      platform: order.platform,
      entityType: "order",
      entityId: order._id,
      message: `Order ${order.orderId} status updated`,
      userId: req.user?._id,
    });

    res.json({ success: true, data: order });
  } catch (err) {
    console.error("[ORDER] Update status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
