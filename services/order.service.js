/**
 * Order Service
 *
 * Read/update business logic for the dedicated Orders module. Extracted
 * 1:1 from controllers/order.controller.js during the clean-architecture
 * migration — every rule, message, and status code below is intentionally
 * unchanged. Backed by the `Order` collection (models/Order.model.js),
 * completely separate from `MarketplaceListing`. Orders are created
 * exclusively by marketplace adapters during sync (see
 * services/adapters/ebayAdapter.js#_upsertOrder); this service only reads
 * and updates status-related fields.
 */
const orderRepository = require("../repositories/order.repository");
const { logAction } = require("./auditLog.service");

function notFound() {
  const err = new Error("Order not found");
  err.statusCode = 404;
  return err;
}

async function getAllOrders(query) {
  const {
    platform,
    status,
    paymentStatus,
    shippingStatus,
    refundStatus,
    customerId,
    conversationId,
    dateFrom,
    dateTo,
    search,
    page = 1,
    limit = 50,
  } = query;

  const mongoQuery = {};

  if (platform) mongoQuery.platform = platform;
  if (status) mongoQuery.status = status;
  if (paymentStatus) mongoQuery.paymentStatus = paymentStatus;
  if (shippingStatus) mongoQuery.shippingStatus = shippingStatus;
  if (refundStatus) mongoQuery.refundStatus = refundStatus;
  if (customerId) mongoQuery.customerId = customerId;
  if (conversationId) mongoQuery.conversationId = conversationId;

  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) range.$lte = new Date(dateTo);
    // Filter on the same field the UI displays as "Order Date"
    // (createdAtEbay — the real marketplace order date), falling back to
    // the record's own createdAt for any document where createdAtEbay
    // isn't set, so existing/older records are never silently excluded.
    // Uses $and (a separate key from the `search` $or below) so both can
    // be applied together without overwriting each other.
    mongoQuery.$and = [
      { $or: [{ createdAtEbay: range }, { createdAtEbay: null, createdAt: range }] },
    ];
  }

  if (search) {
    mongoQuery.$or = [
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
  const total = await orderRepository.countDocuments(mongoQuery);

  const orders = await orderRepository
    .find(mongoQuery)
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

  return {
    data,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
  };
}

async function getOrderById(id) {
  const order = await orderRepository
    .findById(id)
    .populate("customerId", "firstName lastName email mobileNo idProofType")
    .populate("conversationId", "platform status lastMessageAt")
    .lean();

  if (!order) {
    throw notFound();
  }

  return { ...order, customerEmail: order.buyerEmail || null };
}

/**
 * Accepts any of paymentStatus/shippingStatus/trackingNumber. When the
 * caller supplies `platform` in the body, the update is scoped to
 * {_id, platform} for defense-in-depth (mirrors the same opt-in-stricter
 * pattern used by controllers/marketplaceListing.controller.js's status
 * endpoints); when omitted, falls back to id-only lookup.
 */
async function updateOrderStatus(id, body, userId) {
  const { paymentStatus, shippingStatus, trackingNumber, platform } = body;

  const updates = {};
  if (paymentStatus) updates.paymentStatus = paymentStatus;
  if (shippingStatus) updates.shippingStatus = shippingStatus;
  if (trackingNumber) updates.trackingNumber = trackingNumber;

  const filter = platform ? { _id: id, platform } : { _id: id };

  const order = await orderRepository.findOneAndUpdate(filter, updates, { new: true });

  if (!order) {
    throw notFound();
  }

  await logAction({
    action: "order_updated",
    status: "success",
    platform: order.platform,
    entityType: "order",
    entityId: order._id,
    message: `Order ${order.orderId} status updated`,
    userId,
  });

  return order;
}

module.exports = {
  getAllOrders,
  getOrderById,
  updateOrderStatus,
};
