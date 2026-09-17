/**
 * Marketplace Listing business logic. Extracted 1:1 from
 * controllers/marketplaceListing.controller.js during the
 * clean-architecture migration — every search-field list, filter-scoping
 * rule, and platform-adapter sync flow is preserved exactly.
 *
 * `emitNewMessageEvents` stays in the controller (not here) — it needs
 * direct access to `req.app.get("io")`, a transport/HTTP-layer concern,
 * not business logic.
 */
const marketplaceListingRepository = require("../repositories/marketplaceListing.repository");
const integrationAccountRepository = require("../repositories/integrationAccount.repository");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getAll(query) {
  const {
    marketplace, status, orderStatus, priority, search,
    hasListingId, page = 1, limit = 50,
  } = query;

  const filter = {};

  if (marketplace) filter.marketplace = marketplace;
  if (status) filter.conversationStatus = status;
  if (orderStatus) filter.orderStatus = orderStatus;
  if (priority) filter.priority = priority;
  if (hasListingId === "true") filter.marketplaceListingId = { $ne: null };

  if (search) {
    const orConditions = [
      { customerName: { $regex: search, $options: "i" } },
      { customerEmail: { $regex: search, $options: "i" } },
      { marketplaceOrderId: { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
      { trackingNumber: { $regex: search, $options: "i" } },
      { marketplaceListingId: { $regex: search, $options: "i" } },
      { productSku: { $regex: search, $options: "i" } },
      { marketplace: { $regex: search, $options: "i" } },
      { listingStatus: { $regex: search, $options: "i" } },
    ];

    const cleanedNumericInput = search.trim().replace(/^[$€£]\s*/, "").replace(/,/g, "");
    const numericValue = Number(cleanedNumericInput);
    if (cleanedNumericInput !== "" && !Number.isNaN(numericValue)) {
      orConditions.push({ price: numericValue });
      orConditions.push({ quantity: numericValue });
    }

    const parsedDate = new Date(search);
    if (!Number.isNaN(parsedDate.getTime())) {
      const startOfDay = new Date(parsedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(parsedDate);
      endOfDay.setHours(23, 59, 59, 999);
      orConditions.push({ createdAt: { $gte: startOfDay, $lte: endOfDay } });
      orConditions.push({ updatedAt: { $gte: startOfDay, $lte: endOfDay } });
    }

    filter.$or = orConditions;
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const total = await marketplaceListingRepository.countDocuments(filter);

  const leads = await marketplaceListingRepository
    .find(filter)
    .populate("assignedUser", "firstName lastName email")
    .populate("customerId", "firstName lastName email mobileNo")
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

  return {
    data: leads,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
  };
}

async function getById(id) {
  const lead = await marketplaceListingRepository
    .findById(id)
    .populate("assignedUser", "firstName lastName email")
    .populate("customerId", "firstName lastName email mobileNo")
    .lean();

  if (!lead) {
    throw notFoundError("Listing not found");
  }
  return lead;
}

async function updateStatus(id, status, marketplace, userId) {
  const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

  if (!validStatuses.includes(status)) {
    throw badRequestError("Invalid status");
  }

  const filter = marketplace ? { _id: id, marketplace } : { _id: id };

  const lead = await marketplaceListingRepository.findOneAndUpdate(filter, { conversationStatus: status }, { new: true });

  if (!lead) {
    throw notFoundError("Listing not found");
  }

  await logAction({
    action: "lead_updated",
    status: "success",
    platform: lead.marketplace,
    entityType: "marketplace_lead",
    entityId: lead._id,
    message: `Marketplace listing status updated to ${status}`,
    userId,
  });

  return lead;
}

async function assignUser(id, userId) {
  const lead = await marketplaceListingRepository
    .findByIdAndUpdate(id, { assignedUser: userId || null }, { new: true })
    .populate("assignedUser", "firstName lastName email");

  if (!lead) {
    throw notFoundError("Listing not found");
  }
  return lead;
}

async function updateNotes(id, notes) {
  const lead = await marketplaceListingRepository.findByIdAndUpdate(id, { notes }, { new: true });

  if (!lead) {
    throw notFoundError("Listing not found");
  }
  return lead;
}

async function updateOrderStatus(id, body, userId) {
  const { orderStatus, shippingStatus, trackingNumber, marketplace } = body;

  const updates = {};
  if (orderStatus) updates.orderStatus = orderStatus;
  if (shippingStatus) updates.shippingStatus = shippingStatus;
  if (trackingNumber) updates.trackingNumber = trackingNumber;

  const filter = marketplace ? { _id: id, marketplace } : { _id: id };

  const lead = await marketplaceListingRepository.findOneAndUpdate(filter, updates, { new: true });

  if (!lead) {
    throw notFoundError("Listing not found");
  }

  await logAction({
    action: "order_updated",
    status: "success",
    platform: lead.marketplace,
    entityType: "marketplace_lead",
    entityId: lead._id,
    message: `Order ${lead.marketplaceOrderId} status updated`,
    userId,
  });

  return lead;
}

async function remove(id) {
  const lead = await marketplaceListingRepository.findByIdAndUpdate(id, { conversationStatus: "archived" }, { new: true });

  if (!lead) {
    throw notFoundError("Listing not found");
  }
}

async function resolveActiveAccount(platform) {
  const account = await integrationAccountRepository.findOne({ platform, isActive: true }).sort({ createdAt: -1 });
  if (!account) {
    throw notFoundError(`No active ${platform} integration found. Connect ${platform} first.`);
  }

  if (account.isTokenExpired && account.refreshToken) {
    await platformManager.refreshToken(platform, account);
  }

  return account;
}

async function syncOrders(query) {
  const platform = query.platform || "ebay";
  const adapter = platformManager.getAdapter(platform);

  if (!adapter.fetchOrders) {
    throw badRequestError(`fetchOrders() not implemented for ${platform}`);
  }

  const account = await resolveActiveAccount(platform);
  const orders = await adapter.fetchOrders(account, query);
  return { data: orders, count: orders.length };
}

async function syncListings(query) {
  const platform = query.platform || "ebay";
  const adapter = platformManager.getAdapter(platform);

  if (!adapter.fetchListings) {
    throw badRequestError(`fetchListings() not implemented for ${platform}`);
  }

  const account = await resolveActiveAccount(platform);
  const listings = await adapter.fetchListings(account, query);
  return { data: listings, count: listings.length };
}

async function syncMessages(query) {
  const platform = query.platform || "ebay";
  const adapter = platformManager.getAdapter(platform);

  if (!adapter.fetchMessages) {
    throw badRequestError(`fetchMessages() not implemented for ${platform}`);
  }

  const account = await resolveActiveAccount(platform);
  const conversations = await adapter.fetchMessages(account, query);
  return { data: conversations, count: conversations.length };
}

async function syncAll(body, query) {
  const platform = body.platform || query.platform || "ebay";
  const adapter = platformManager.getAdapter(platform);

  if (!adapter.sync) {
    throw badRequestError(`sync() not implemented for ${platform}`);
  }

  const account = await resolveActiveAccount(platform);
  const result = await adapter.sync(account, body);

  return {
    result,
    summary: {
      orders: result.orders.length,
      listings: result.listings.length,
      messages: result.messages.length,
    },
  };
}

async function testEbayConversations() {
  console.log("==== 1 ====");

  const ebayAdapter = require("../services/adapters/ebayAdapter");

  console.log("==== 2 ====");

  const account = await integrationAccountRepository.findOne({ platform: "ebay", isConnected: true });

  console.log("==== 3 ====");

  if (!account) {
    throw notFoundError("No connected eBay account found.");
  }

  console.log("==== 4 ====");

  const result = await ebayAdapter.testConversations(account);

  console.log("==== 5 ====");

  return result;
}

module.exports = {
  getAll,
  getById,
  updateStatus,
  assignUser,
  updateNotes,
  updateOrderStatus,
  remove,
  syncOrders,
  syncListings,
  syncMessages,
  syncAll,
  testEbayConversations,
};
