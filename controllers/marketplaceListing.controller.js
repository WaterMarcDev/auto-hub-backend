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
const EbaySyncRun = require("../models/EbaySyncRun.model");
const platformManager = require("../services/platformManager.service");
const ebayListingReconcile = require("../services/ebay/ebayListingReconcile.service");
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
      // itself parses as a number. Strips a leading currency symbol and
      // thousands separators first (e.g. "$99.99" or "1,000") since the
      // Price column displays values with a "$" prefix — without this, a
      // search copied straight from that column would never parse as a
      // number and silently match nothing.
      const cleanedNumericInput = search.trim().replace(/^[$€£]\s*/, "").replace(/,/g, "");
      const numericValue = Number(cleanedNumericInput);
      if (cleanedNumericInput !== "" && !Number.isNaN(numericValue)) {
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
 *
 * CRM-ONLY removal. This deletes the CRM's own MarketplaceListing record and
 * nothing else: it never calls eBay (no EndItem/WithdrawOffer/revise), never
 * touches the linked inventory item, and never affects Amazon or any other
 * marketplace. The corresponding eBay listing keeps running on eBay exactly as
 * before — a future eBay→CRM sync simply re-imports it if it is still active.
 *
 * NOTE: this is deliberately a hard delete rather than an archive. The
 * Marketplace Listings page must actually stop showing the row, and
 * getAll() has no archived filter, so an archived record would remain visible
 * and look like the delete silently failed.
 */
exports.remove = async (req, res) => {
  try {
    const lead = await MarketplaceListing.findByIdAndDelete(req.params.id);

    if (!lead) {
      return res.status(404).json({ success: false, message: "Listing not found" });
    }

    console.log(
      "[EBAY SYNC] Removed CRM marketplace listing record (CRM-only; eBay listing untouched):",
      {
        id: String(lead._id),
        marketplace: lead.marketplace,
        marketplaceListingId: lead.marketplaceListingId || null,
      }
    );

    await logAction({
      action: "listing_deleted",
      status: "success",
      platform: lead.marketplace,
      entityType: "marketplace_listing",
      entityId: lead._id,
      message: `Removed CRM listing record ${lead.marketplaceListingId || lead._id} (CRM-only; no marketplace side effects)`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Listing removed from CRM" });
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
 * GET|POST /api/marketplace-leads/listings
 *
 * MANUAL "Sync eBay Listings" endpoint. Runs the full authoritative eBay →
 * CRM reconciliation (see services/ebay/ebayListingReconcile.service.js) and
 * returns the reconciliation stats the Marketplace Listings page displays.
 *
 * Pass ?dryRun=true to compute the plan without writing anything.
 */
exports.syncListings = async (req, res) => {
  try {
    const platform = req.query.platform || req.body?.platform || "ebay";
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

    // eBay's reconciliation engine refreshes the token itself (through the
    // existing adapter refreshToken), so only non-eBay platforms are refreshed
    // here — avoids refreshing the same token twice in one request.
    if (platform !== "ebay" && account.isTokenExpired && account.refreshToken) {
      await platformManager.refreshToken(platform, account);
    }

    // eBay only: reuse the SAME Mongo-backed EbaySyncRun lock the scheduled
    // jobs use — never a second locking mechanism. This guarantees a manual
    // click can never overlap the 30-minute reconcile, nor the CRM → eBay
    // catalog push, so the two directions never interleave their writes. If a
    // run already holds the lock, tell the caller rather than running two
    // reconciliations against the same collection.
    const isEbay = platform === "ebay";
    let run = null;
    if (isEbay) {
      run = await EbaySyncRun.acquireLock("manual");
      if (!run) {
        return res.status(409).json({
          success: false,
          code: "EBAY_SYNC_IN_PROGRESS",
          message:
            "An eBay sync is already running. Please wait for it to finish and try again.",
        });
      }
    }

    let listings;
    try {
      listings = await adapter.fetchListings(account, {
        dryRun: req.query.dryRun === "true" || req.body?.dryRun === true,
        pageSize: req.query.pageSize || req.body?.pageSize,
      });

      if (run) {
        await EbaySyncRun.releaseLock(run, "completed", {
          totalDiscovered: listings.summary?.activeOnEbay ?? 0,
          totalCreated: listings.summary?.created ?? 0,
          totalUpdated: listings.summary?.updated ?? 0,
          totalUnchanged: listings.summary?.unchanged ?? 0,
          totalFailed: listings.summary?.fetchComplete === false ? 1 : 0,
          error: listings.summary?.fetchError || null,
        });
        run = null;
      }
    } catch (innerErr) {
      // Always release the lock on failure so a single error can never wedge
      // every future scheduled/manual eBay sync behind a stale lock.
      if (run) {
        try {
          await EbaySyncRun.releaseLock(run, "failed", {
            totalFailed: 1,
            error: innerErr.message || String(innerErr),
          });
        } catch (releaseErr) {
          console.error(
            "[MARKETPLACE LISTING] Failed to release eBay sync lock:",
            releaseErr.message
          );
        }
        run = null;
      }
      throw innerErr;
    }

    const summary = listings.summary || null;

    res.json({
      success: true,
      data: listings,
      count: listings.length,
      summary: summary
        ? {
            activeOnEbay: summary.activeOnEbay,
            created: summary.created,
            updated: summary.updated,
            unchanged: summary.unchanged,
            removed: summary.removed,
            duplicatesCollapsed: summary.duplicatesCollapsed,
            fetchComplete: summary.fetchComplete,
            fetchError: summary.fetchError,
            staleRemovalSkipped: summary.staleRemovalSkipped,
            durationMs: summary.durationMs,
          }
        : null,
    });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] Sync listings error:", err);
    res
      .status(err.statusCode || 500)
      .json({ success: false, code: err.code || null, message: err.message });
  }
};

/**
 * GET /api/marketplace-leads/ebay/integrity
 *
 * Read-only integrity report for the eBay Marketplace Listing dataset (counts
 * only, no side effects): totals, duplicate listing ids, missing/invalid ids,
 * and records still carrying an unresolved "Unknown" status. Used by the
 * Marketplace Listings page and by the reconciliation verification script.
 */
exports.getEbayListingsIntegrity = async (req, res) => {
  try {
    const integrity = await ebayListingReconcile.summarizeEbayMarketplaceListings();
    res.json({ success: true, data: integrity });
  } catch (err) {
    console.error("[MARKETPLACE LISTING] eBay integrity report error:", err);
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
