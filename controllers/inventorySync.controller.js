/**
 * Inventory sync — staff actions and monitoring (base path /api/inventory-sync).
 *
 * Every stock change goes through services/inventoryLedger.service.js, so it
 * is atomic, never negative, exactly-once per request id, audited, pushed to
 * eBay (unless it came from eBay) and refreshed live in open CRM pages.
 */
const mongoose = require("mongoose");
const Inventory = require("../models/Inventory.model");
const InventoryTransaction = require("../models/InventoryTransaction.model");
const MarketplaceEvent = require("../models/MarketplaceEvent.model");
const ledger = require("../services/inventoryLedger.service");
const ebayQuantitySync = require("../services/ebayQuantitySync.service");
const ebayNotification = require("../services/ebayNotification.service");
const reconciliation = require("../services/inventoryReconciliation.service");
const realtime = require("../utils/realtime");

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const clean = (v) => (v === undefined || v === null ? undefined : String(v).trim() || undefined);
const page = (q) => Math.max(1, parseInt(q.page, 10) || 1);
const limitOf = (q, d = 25) => Math.min(200, Math.max(1, parseInt(q.limit, 10) || d));

function badId(res) {
  return res.status(400).json({ success: false, message: "Invalid part id" });
}

const OUTCOME_HTTP = {
  insufficient: [409, "Not enough stock for this part."],
  removed: [409, "This part has been removed from inventory."],
  missing: [404, "Part not found."],
};

// POST /parts/:id/sell — in-store (CRM) sale
exports.sellInStore = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return badId(res);
    const { quantity = 1, price, buyerName, buyerPhone, note, requestId } = req.body || {};
    if (!REQUEST_ID.test(String(requestId || ""))) {
      return res.status(400).json({ success: false, message: "requestId (8–64 letters/digits/-/_) is required" });
    }
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 1 || qty > 100) {
      return res.status(400).json({ success: false, message: "quantity must be a whole number between 1 and 100" });
    }
    const amount = price === undefined || price === null || price === "" ? undefined : Number(price);
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(400).json({ success: false, message: "price must be a positive number" });
    }

    const now = new Date();
    const r = await ledger.deduct({
      inventoryId: id,
      quantity: qty,
      key: `crm-sale:${requestId}`,
      source: "CRM_SALE",
      channel: "crm",
      orderId: requestId,
      orderLineItemId: requestId,
      countAsSale: true,
      createdBy: req.user?._id,
      reason: clean(note),
      sale: {
        channel: "crm",
        orderId: requestId,
        orderNumber: `IN-STORE-${requestId.slice(0, 8).toUpperCase()}`,
        lineItemId: requestId,
        quantity: qty,
        price: amount,
        currency: "USD",
        soldAt: now,
        orderStatus: "Completed",
        paymentStatus: "Paid",
        shippingStatus: "Picked up",
        buyerName: clean(buyerName),
        buyerPhone: clean(buyerPhone),
      },
      details: { price: amount, note: clean(note) },
    });

    if (r.outcome === "applied" || r.outcome === "duplicate") {
      const part = await Inventory.findById(id).select("quantityAvailable saleStatus ebayQuantitySync").lean();
      return res.json({ success: true, alreadyProcessed: r.outcome === "duplicate", data: part });
    }
    const [status, message] = OUTCOME_HTTP[r.outcome] || [500, "Sale failed"];
    return res.status(status).json({ success: false, message });
  } catch (err) {
    console.error("[INVENTORY SYNC] sell error:", err);
    return res.status(500).json({ success: false, message: "Server error while recording the sale" });
  }
};

// POST /parts/:id/adjust — manual stock correction (admin/manager)
exports.adjustStock = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return badId(res);
    const { delta, reason, requestId } = req.body || {};
    const d = Math.trunc(Number(delta));
    if (!REQUEST_ID.test(String(requestId || ""))) {
      return res.status(400).json({ success: false, message: "requestId is required" });
    }
    if (!d || Math.abs(d) > 100) return res.status(400).json({ success: false, message: "delta must be a non-zero whole number (max ±100)" });
    if (!clean(reason)) return res.status(400).json({ success: false, message: "A reason is required for a manual adjustment" });

    const r = await ledger.changeStock({
      inventoryId: id,
      delta: d,
      key: `manual-adjust:${requestId}`,
      source: "MANUAL_ADJUSTMENT",
      type: "adjust",
      channel: "crm",
      reason: clean(reason),
      createdBy: req.user?._id,
      requireActive: d < 0,
    });
    if (r.outcome === "applied" || r.outcome === "duplicate") {
      const part = await Inventory.findById(id).select("quantityAvailable saleStatus ebayQuantitySync").lean();
      return res.json({ success: true, alreadyProcessed: r.outcome === "duplicate", data: part });
    }
    const [status, message] = OUTCOME_HTTP[r.outcome] || [500, "Adjustment failed"];
    return res.status(status).json({ success: false, message });
  } catch (err) {
    console.error("[INVENTORY SYNC] adjust error:", err);
    return res.status(500).json({ success: false, message: "Server error while adjusting stock" });
  }
};

// POST /parts/:id/return/received — the returned part is physically back
exports.returnReceived = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return badId(res);
    const part = await Inventory.findById(id).select("returnInfo sale quantitySold").lean();
    if (!part) return res.status(404).json({ success: false, message: "Part not found" });

    const status = part.returnInfo?.status;
    if (["received", "inspection_passed", "inspection_failed"].includes(status)) {
      return res.status(409).json({ success: false, message: `Return is already ${status.replace("_", " ")}` });
    }
    if (!part.returnInfo && !part.sale && !(part.quantitySold > 0)) {
      return res.status(409).json({ success: false, message: "This part has no sale to return" });
    }

    const now = new Date();
    const returnInfo = part.returnInfo
      ? { ...part.returnInfo, status: "received", receivedAt: now, updatedAt: now }
      : {
          channel: part.sale?.channel || "crm",
          orderId: part.sale?.orderId,
          status: "received",
          requestedAt: now,
          receivedAt: now,
          updatedAt: now,
        };
    const r = await Inventory.updateOne(
      { _id: id, "returnInfo.status": { $nin: ["received", "inspection_passed", "inspection_failed"] } },
      { $set: { returnInfo } }
    );
    if (!r.modifiedCount) return res.status(409).json({ success: false, message: "Return state changed — reload and try again" });

    await ledger.recordInfo({
      key: `return-received:${returnInfo.returnId || returnInfo.orderId || "manual"}:${id}:${now.getTime()}`,
      inventoryId: id,
      source: returnInfo.channel === "ebay" ? "EBAY_RETURN" : "MANUAL_ADJUSTMENT",
      channel: returnInfo.channel,
      orderId: returnInfo.orderId,
      returnId: returnInfo.returnId,
      reason: "Returned part received — awaiting inspection (stock unchanged)",
      createdBy: req.user?._id,
    });
    realtime.invalidate("inventory", "soldProducts", "inventorySync");
    return res.json({ success: true, data: { returnInfo } });
  } catch (err) {
    console.error("[INVENTORY SYNC] return received error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /parts/:id/return/inspection { result: "pass" | "fail", notes }
exports.returnInspection = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return badId(res);
    const result = String(req.body?.result || "").toLowerCase();
    if (!["pass", "fail"].includes(result)) {
      return res.status(400).json({ success: false, message: 'result must be "pass" or "fail"' });
    }
    const notes = clean(req.body?.notes);
    const part = await Inventory.findById(id).select("returnInfo sku").lean();
    if (!part?.returnInfo) return res.status(404).json({ success: false, message: "No return recorded for this part" });

    const ri = part.returnInfo;
    // "pass" may be repeated after a failure mid-way; the restock key makes it once-only.
    const allowed = result === "pass" ? ["received", "inspection_passed"] : ["received"];
    if (!allowed.includes(ri.status)) {
      return res.status(409).json({ success: false, message: `Mark the part as received first (current: ${ri.status})` });
    }
    const now = new Date();

    if (result === "fail") {
      await Inventory.updateOne(
        { _id: id, "returnInfo.status": "received" },
        { $set: { "returnInfo.status": "inspection_failed", "returnInfo.inspectedAt": now, "returnInfo.inspectedBy": req.user?._id, "returnInfo.inspectionNotes": notes, "returnInfo.updatedAt": now } }
      );
      await ledger.recordInfo({
        key: `return-inspection-failed:${ri.returnId || ri.orderId || "manual"}:${id}:${new Date(ri.receivedAt || now).getTime()}`,
        inventoryId: id,
        source: ri.channel === "ebay" ? "EBAY_RETURN" : "MANUAL_ADJUSTMENT",
        channel: ri.channel,
        orderId: ri.orderId,
        returnId: ri.returnId,
        reason: `Returned part failed inspection — not restocked${notes ? `: ${notes}` : ""}`,
        createdBy: req.user?._id,
      });
      realtime.invalidate("inventory", "soldProducts", "inventorySync");
      return res.json({ success: true, restocked: false });
    }

    const r = await ledger.restore({
      inventoryId: id,
      quantity: 1,
      key: `return-restock:${ri.returnId || ri.orderId || "manual"}:${id}:${new Date(ri.receivedAt || now).getTime()}`,
      source: ri.channel === "ebay" ? "EBAY_RESTOCK" : "MANUAL_ADJUSTMENT",
      channel: ri.channel,
      orderId: ri.orderId,
      returnId: ri.returnId,
      uncountSale: true,
      clearSaleOfOrder: ri.orderId,
      reason: `Returned part passed inspection — back in stock${notes ? `: ${notes}` : ""}`,
      createdBy: req.user?._id,
    });
    if (r.outcome === "missing") return res.status(404).json({ success: false, message: "Part not found" });
    await Inventory.updateOne(
      { _id: id },
      { $set: { "returnInfo.status": "inspection_passed", "returnInfo.inspectedAt": now, "returnInfo.inspectedBy": req.user?._id, "returnInfo.inspectionNotes": notes, "returnInfo.updatedAt": now } }
    );
    realtime.invalidate("inventory", "soldProducts", "inventorySync");
    return res.json({ success: true, restocked: r.outcome === "applied", alreadyProcessed: r.outcome === "duplicate" });
  } catch (err) {
    console.error("[INVENTORY SYNC] inspection error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /transactions — ledger (filters: inventoryId, source, orderId)
exports.listTransactions = async (req, res) => {
  try {
    const q = req.query;
    const filter = {};
    if (q.inventoryId && mongoose.isValidObjectId(q.inventoryId)) filter.inventoryId = q.inventoryId;
    if (q.source) filter.source = String(q.source);
    if (q.orderId) filter.orderId = String(q.orderId);
    const p = page(q);
    const l = limitOf(q, 50);
    const [items, total] = await Promise.all([
      InventoryTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .populate("inventoryId", "partName vin sku")
        .populate("createdBy", "first_name last_name")
        .lean(),
      InventoryTransaction.countDocuments(filter),
    ]);
    return res.json({ success: true, data: items, pagination: { page: p, limit: l, total } });
  } catch (err) {
    console.error("[INVENTORY SYNC] transactions error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /ebay-sync — eBay quantity push queue (default: failed + dead + pending)
exports.listEbaySync = async (req, res) => {
  try {
    const statuses = String(req.query.status || "failed,dead,pending").split(",").map((s) => s.trim()).filter(Boolean);
    const items = await Inventory.find({ "ebayQuantitySync.status": { $in: statuses } })
      .select("partName vin sku ebayListingId quantityAvailable saleStatus ebayQuantitySync")
      .sort({ "ebayQuantitySync.updatedAt": -1 })
      .limit(200)
      .lean();
    return res.json({ success: true, data: items });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.retryEbaySync = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return badId(res);
  const ok = await ebayQuantitySync.retry(req.params.id);
  return ok ? res.json({ success: true }) : res.status(404).json({ success: false, message: "Nothing to retry for this part" });
};

exports.runEbaySync = async (req, res) => {
  try {
    const out = await ebayQuantitySync.processQueue();
    return res.json({ success: true, data: out });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /events — eBay webhook inbox (default: failed + dead)
exports.listEvents = async (req, res) => {
  try {
    const statuses = String(req.query.status || "failed,dead").split(",").map((s) => s.trim()).filter(Boolean);
    const items = await MarketplaceEvent.find({ status: { $in: statuses } })
      .select("-payload")
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    return res.json({ success: true, data: items });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.retryEvent = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
  const ok = await ebayNotification.retryEvent(req.params.id);
  return ok ? res.json({ success: true }) : res.status(404).json({ success: false, message: "Event is not failed/dead" });
};

// GET /returns — returns needing or having had staff action
exports.listReturns = async (req, res) => {
  try {
    const statuses = String(req.query.status || "requested,in_transit,delivered,received")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const items = await Inventory.find({ "returnInfo.status": { $in: statuses } })
      .select("partName vin sku year make model quantityAvailable saleStatus sale.channel sale.orderNumber sale.buyerName returnInfo")
      .populate("make", "name")
      .populate("model", "name")
      .sort({ "returnInfo.updatedAt": -1 })
      .limit(200)
      .lean();
    return res.json({ success: true, data: items });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getReconciliation = async (req, res) => {
  const report = await reconciliation.getLatestReport();
  return res.json({ success: true, data: report });
};

exports.runReconciliation = async (req, res) => {
  try {
    const report = await reconciliation.runReconciliation();
    return res.json({ success: true, data: report });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /summary — badge counts for the Inventory Sync page
exports.summary = async (req, res) => {
  try {
    const [failedSync, failedEvents, returnsOpen, pendingSync] = await Promise.all([
      Inventory.countDocuments({ "ebayQuantitySync.status": { $in: ["failed", "dead"] } }),
      MarketplaceEvent.countDocuments({ status: { $in: ["failed", "dead"] } }),
      Inventory.countDocuments({ "returnInfo.status": { $in: ["requested", "in_transit", "delivered", "received"] } }),
      Inventory.countDocuments({ "ebayQuantitySync.status": "pending" }),
    ]);
    const report = await reconciliation.getLatestReport();
    return res.json({
      success: true,
      data: { failedSync, pendingSync, failedEvents, returnsOpen, reconciliation: report ? { runAt: report.runAt, totalIssues: report.totalIssues, counts: report.counts } : null },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
