/**
 * Central inventory ledger — the ONLY place stock quantity changes.
 *
 * Every change (eBay/Wix sale, in-store sale, cancellation, return restock,
 * manual adjustment) is:
 *   1. Atomic: one findOneAndUpdate on the Inventory document. Deductions
 *      only match when enough stock exists, so stock can never go negative
 *      and two simultaneous sales of the last unit can't both succeed.
 *   2. Exactly-once: the change's idempotency `key` is pushed onto
 *      Inventory.appliedTxKeys IN THE SAME UPDATE, and the update only matches
 *      when the key isn't there yet. A retried webhook/poll/click with the
 *      same key is reported as "duplicate" and changes nothing.
 *   3. Audited: an InventoryTransaction row (unique key) records previous
 *      quantity, change, new quantity, source and references.
 *   4. Propagated: open CRM pages are told to refresh (Socket.IO), and any
 *      change that did NOT originate on eBay queues an eBay quantity update
 *      (eBay already adjusted its own listing for an eBay sale → no loop).
 *
 * No Mongo transaction is needed: the stock change and its idempotency
 * marker live in one document and change in one atomic write. The ledger
 * row is written right after; if that write fails, the next retry of the
 * same key repairs it (outcome "duplicate" → ledger row recovered).
 *
 * Quantity: parts without quantityAvailable count as 1 (one record = one
 * physical part). saleStatus follows quantity: 0 → "sold" (out of stock),
 * >0 → "available".
 */
const Inventory = require("../models/Inventory.model");
const InventoryTransaction = require("../models/InventoryTransaction.model");
const realtime = require("../utils/realtime");

const LOG_PREFIX = "[INVENTORY LEDGER]";
const KEEP_KEYS = 100;
// Missing quantity = 1 physical part, or 0 if it was already marked sold
// before quantities existed.
const QTY = { $ifNull: ["$quantityAvailable", { $cond: [{ $eq: ["$saleStatus", "sold"] }, 0, 1] }] };
const currentQty = (doc) => doc.quantityAvailable ?? (doc.saleStatus === "sold" ? 0 : 1);
const SOLD = { $ifNull: ["$quantitySold", 0] };

// Changes that already happened on eBay itself — never pushed back to eBay.
const EBAY_ORIGINATED = new Set(["EBAY_SALE"]);

const toInt = (n, fallback = 1) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Awaited so the eBay update is durably queued before the caller responds
// (the queue entry is a field on the part, so it survives restarts).
// A queue failure is logged, never undoes the stock change; reconciliation
// reports any resulting eBay mismatch.
async function afterApplied(inventoryId, source) {
  if (!EBAY_ORIGINATED.has(source)) {
    try {
      // Lazy: the queue service requires this module.
      await require("./ebayQuantitySync.service").enqueue(inventoryId, source);
    } catch (err) {
      console.error(`${LOG_PREFIX} could not queue eBay quantity update for ${inventoryId}:`, err.message);
    }
  }
  realtime.invalidate("inventory", "soldProducts", "inventorySync");
}

async function writeLedger(key, fields, status) {
  try {
    if (status === "applied") {
      await InventoryTransaction.findOneAndUpdate(
        { key },
        { $set: { ...fields, key, status } },
        { upsert: true, setDefaultsOnInsert: true }
      );
    } else {
      // Never downgrade an applied row (that would hide a real change).
      await InventoryTransaction.updateOne(
        { key, status: { $ne: "applied" } },
        { $set: { ...fields, key, status } },
        { upsert: true }
      );
    }
  } catch (err) {
    if (err && err.code === 11000) return; // an applied row already exists
    console.error(`${LOG_PREFIX} ledger write failed for ${key}:`, err.message);
  }
}

/**
 * Change stock by `delta` (negative = deduct, positive = restore/add).
 *
 * @param {Object} o
 * @param {*}      o.inventoryId
 * @param {number} o.delta
 * @param {string} o.key           idempotency key (required)
 * @param {string} o.source        InventoryTransaction source
 * @param {string} [o.type]        deduct | restore | adjust
 * @param {boolean} [o.countAsSale]   add |delta| to quantitySold
 * @param {boolean} [o.uncountSale]   subtract |delta| from quantitySold
 * @param {Object} [o.sale]        replaces Inventory.sale (latest sale details)
 * @param {string} [o.clearSaleOfOrder] clears Inventory.sale if it belongs to this order
 * @param {boolean} [o.requireActive=delta<0] refuse deductions on removed parts
 * @returns {Promise<{outcome: "applied"|"duplicate"|"insufficient"|"removed"|"missing", previousQuantity?, newQuantity?}>}
 */
async function changeStock(o) {
  const { inventoryId, key, source } = o;
  if (!key) throw new Error("changeStock: key is required");
  const delta = Math.trunc(Number(o.delta));
  if (!delta) throw new Error("changeStock: delta must be a non-zero integer");
  const q = Math.abs(delta);
  const type = o.type || (delta < 0 ? "deduct" : "restore");
  const requireActive = o.requireActive ?? delta < 0;

  const ledgerFields = {
    inventoryId,
    sku: o.sku,
    source,
    type,
    quantity: q,
    channel: o.channel,
    orderId: o.orderId,
    orderLineItemId: o.orderLineItemId,
    listingId: o.listingId,
    returnId: o.returnId,
    refundId: o.refundId,
    reason: o.reason,
    details: o.details,
    createdBy: o.createdBy,
  };

  // Fast duplicate check (also covers keys trimmed off the part's list).
  if (await InventoryTransaction.exists({ key, status: "applied" })) {
    return { outcome: "duplicate" };
  }

  const now = new Date();
  const set1 = {
    quantityAvailable: delta < 0 ? { $subtract: [QTY, q] } : { $add: [QTY, q] },
    appliedTxKeys: { $slice: [{ $concatArrays: [{ $ifNull: ["$appliedTxKeys", []] }, [key]] }, -KEEP_KEYS] },
  };
  if (o.countAsSale) set1.quantitySold = { $add: [SOLD, q] };
  if (o.uncountSale) set1.quantitySold = { $max: [0, { $subtract: [SOLD, q] }] };
  if (o.sale) set1.sale = { $literal: { ...o.sale, recordedAt: now, lastSyncedAt: now } };
  else if (o.clearSaleOfOrder) {
    set1.sale = { $cond: [{ $eq: ["$sale.orderId", String(o.clearSaleOfOrder)] }, null, "$sale"] };
  }
  const set2 = { saleStatus: { $cond: [{ $gt: ["$quantityAvailable", 0] }, "available", "sold"] } };

  const filter = { _id: inventoryId, appliedTxKeys: { $ne: key } };
  if (delta < 0) filter.$expr = { $gte: [QTY, q] };
  if (requireActive) filter.isDeleted = { $ne: true };

  const updated = await Inventory.findOneAndUpdate(filter, [{ $set: set1 }, { $set: set2 }], {
    new: true,
    projection: { quantityAvailable: 1, sku: 1 },
  }).lean();

  if (updated) {
    const newQuantity = updated.quantityAvailable;
    const previousQuantity = newQuantity - delta;
    await writeLedger(key, { ...ledgerFields, sku: o.sku || updated.sku, previousQuantity, newQuantity }, "applied");
    await afterApplied(inventoryId, source);
    return { outcome: "applied", previousQuantity, newQuantity };
  }

  // Nothing matched — find out why.
  const doc = await Inventory.findById(inventoryId).select("+appliedTxKeys quantityAvailable saleStatus isDeleted sku").lean();
  if (!doc) return { outcome: "missing" };
  if ((doc.appliedTxKeys || []).includes(key)) {
    await writeLedger(key, { ...ledgerFields, reason: "stock already changed by this key (ledger recovered)" }, "applied");
    return { outcome: "duplicate" };
  }
  const outcome = requireActive && doc.isDeleted ? "removed" : "insufficient";
  await writeLedger(
    key,
    {
      ...ledgerFields,
      sku: o.sku || doc.sku,
      previousQuantity: currentQty(doc),
      newQuantity: currentQty(doc),
      reason: outcome === "removed" ? "part was removed from inventory" : `not enough stock (needed ${q})`,
    },
    "rejected"
  );
  return { outcome, previousQuantity: currentQty(doc) };
}

const deduct = (o) => changeStock({ ...o, delta: -toInt(o.quantity), type: o.type || "deduct" });
const restore = (o) => changeStock({ ...o, delta: toInt(o.quantity), type: o.type || "restore", requireActive: false });

/** Record an event that does NOT change stock (e.g. refund without return). Once per key. */
async function recordInfo(o) {
  if (await InventoryTransaction.exists({ key: o.key })) return { outcome: "duplicate" };
  await writeLedger(
    o.key,
    {
      inventoryId: o.inventoryId,
      sku: o.sku,
      source: o.source,
      type: "info",
      quantity: 0,
      channel: o.channel,
      orderId: o.orderId,
      orderLineItemId: o.orderLineItemId,
      returnId: o.returnId,
      refundId: o.refundId,
      reason: o.reason,
      details: o.details,
      createdBy: o.createdBy,
    },
    "recorded"
  );
  realtime.invalidate("inventorySync");
  return { outcome: "recorded" };
}

module.exports = { changeStock, deduct, restore, recordInfo, EBAY_ORIGINATED };
