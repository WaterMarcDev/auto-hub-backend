/**
 * Marketplace Sales → CRM (sold status)
 *
 * When a synced part sells on eBay or Wix, this service finds the CRM
 * Inventory part behind the order line and marks it sold, saving the full
 * order details on the part (Inventory.saleStatus / Inventory.sale).
 *
 * HOW A SALE IS MATCHED TO A CRM PART
 *   eBay — the eBay SKU of every listing the CRM publishes IS the Inventory
 *          _id (services/ebay/ebayProductMapper.service.js: sku = item._id).
 *          Fallbacks: Inventory.ebaySku, then the eBay item id
 *          (lineItem.legacyItemId) against Inventory.ebayListingId.
 *   Wix  — one Wix product can stand for several identical CRM parts (the
 *          Wix sync groups them and sends their count as the quantity). Every
 *          part in the group carries the Wix product id (Inventory.wixProductId),
 *          which is the order line's catalogReference.catalogItemId. A line of
 *          quantity N marks N available parts of that group sold (oldest first).
 *
 * WHAT "SOLD" DOES
 *   - saleStatus = "sold", sale = { channel, order no., date, price, buyer,
 *     shipping address, order/payment/shipping status, tracking, … }.
 *   - The part leaves available stock: the eBay catalog sync and the Wix sync
 *     no longer count or push sold parts (so a sold part is never re-listed).
 *   - The part is NOT deleted: it stays visible on the Sold Products page.
 *   - A cancelled order puts its parts back to "available".
 *   - If a part already sold in one order shows up in another order (sold
 *     twice), the second order is stored in saleConflicts for staff to handle.
 *
 * WHEN IT RUNS
 *   - Every eBay order the CRM syncs (manual "Sync Orders" and the scheduled
 *     job) — hooked into ebayAdapter._upsertOrder, best-effort.
 *   - jobs/marketplaceSalesSyncJob.js — every 15 minutes, eBay + Wix.
 *   - "Sync now" on the Sold Products page (POST /api/sold-products/sync).
 * Everything is idempotent: seeing the same order again only refreshes its
 * details (status, tracking).
 *
 * This service never writes to eBay or Wix — it only reads orders.
 */
const axios = require("axios");
const mongoose = require("mongoose");
const Inventory = require("../models/Inventory.model");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const MarketplaceSaleSync = require("../models/MarketplaceSaleSync.model");
const { normalizeOrderStatuses } = require("./orderStatusMapper.service");
const { logAction } = require("./auditLog.service");
const ledger = require("./inventoryLedger.service");

const LOG_PREFIX = "[MARKETPLACE SALES]";

const toPositiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** First sync looks back this many days; later syncs continue from the last success. */
const FIRST_RUN_LOOKBACK_DAYS = toPositiveInt(process.env.MARKETPLACE_SALES_LOOKBACK_DAYS, 30);
/** Each run re-reads this much before the last success, so nothing slips between runs. */
const OVERLAP_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 40;
const MAX_UNMATCHED_STORED = 50;

const WIX_ORDERS_SEARCH_URL = "https://www.wixapis.com/ecom/v1/orders/search";
const WIX_PAGE_SIZE = 100;

const SALE_CHANNELS = ["ebay", "wix"];

// ─── helpers ────────────────────────────────────────────────────────────────

const clean = (v) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s && s !== "N/A" ? s : undefined;
};
const toNumber = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};
const toDate = (v) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const isObjectIdString = (s) => typeof s === "string" && /^[a-f0-9]{24}$/i.test(s);

/** Drop undefined keys so $set never overwrites a stored value with nothing. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !(v instanceof Date) && !mongoose.isValidObjectId(v)) {
      const inner = compact(v);
      if (Object.keys(inner).length) out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** { "sale.a": 1, "sale.b.c": 2 } from { a: 1, b: { c: 2 } } */
function flattenForSet(prefix, obj, out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = `${prefix}.${k}`;
    if (v && typeof v === "object" && !(v instanceof Date) && !mongoose.isValidObjectId(v)) {
      flattenForSet(path, v, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

// ─── core: mark sold / release (through the central ledger) ─────────────────

const SALE_SOURCE = { ebay: "EBAY_SALE", wix: "WIX_SALE" };
const CANCEL_SOURCE = { ebay: "EBAY_CANCELLATION", wix: "WIX_CANCELLATION" };

const saleKey = (sale, unit) =>
  `${sale.channel}-sale:${sale.orderId}:${sale.lineItemId}${unit ? `:${unit}` : ""}`;

async function recordConflict(inventoryId, sale) {
  const now = new Date();
  const conflict = await Inventory.findOneAndUpdate(
    {
      _id: inventoryId,
      "sale.orderId": { $ne: sale.orderId },
      $nor: [{ saleConflicts: { $elemMatch: { channel: sale.channel, orderId: sale.orderId } } }],
    },
    {
      $push: {
        saleConflicts: compact({
          channel: sale.channel,
          orderId: sale.orderId,
          orderNumber: sale.orderNumber,
          soldAt: sale.soldAt,
          buyerName: sale.buyerName,
          detectedAt: now,
        }),
      },
    },
    { new: true, projection: { _id: 1, partName: 1, vin: 1, sale: 1, isDeleted: 1 } }
  );
  if (!conflict) return false;
  const before = conflict.sale
    ? `already sold on ${conflict.sale.channel} order ${conflict.sale.orderNumber || conflict.sale.orderId}`
    : conflict.isDeleted
      ? "already removed from inventory"
      : "out of stock";
  console.warn(
    `${LOG_PREFIX} SOLD TWICE: part ${inventoryId} (${conflict.partName || ""} ${conflict.vin || ""}) ${before}, ` +
      `now also on ${sale.channel} order ${sale.orderNumber || sale.orderId}`
  );
  await logAction({
    action: "marketplace_sale_conflict",
    status: "failure",
    platform: sale.channel,
    entityType: "inventory",
    entityId: String(inventoryId),
    message: `Part sold twice: ${before}, also sold on ${sale.channel} order ${sale.orderNumber || sale.orderId}`,
  }).catch(() => {});
  return true;
}

/**
 * Deduct stock for one marketplace order line (or one unit of it for Wix).
 * Exactly once per (order, line[, unit]) — see services/inventoryLedger.service.js.
 * @param {Object} sale - fields of Inventory.sale (channel, orderId, lineItemId required)
 * @param {Object} [opts] - { unit } for per-unit Wix keys, { quantity } to deduct
 * @returns {Promise<"sold"|"refreshed"|"conflict"|"missing">}
 */
async function markPartSold(inventoryId, sale, opts = {}) {
  const now = new Date();
  const details = compact({ ...sale, lastSyncedAt: now });
  const result = await ledger.deduct({
    inventoryId,
    quantity: opts.quantity || sale.quantity || 1,
    key: saleKey(sale, opts.unit),
    source: SALE_SOURCE[sale.channel] || "EBAY_SALE",
    channel: sale.channel,
    orderId: sale.orderId,
    orderLineItemId: sale.lineItemId,
    listingId: sale.listingId,
    countAsSale: true,
    sale: details,
    details: { orderNumber: sale.orderNumber, price: sale.price, currency: sale.currency, buyerName: sale.buyerName },
  });

  if (result.outcome === "applied") return "sold";
  if (result.outcome === "missing") return "missing";

  if (result.outcome === "duplicate") {
    // Same order line seen again → refresh its details (status, tracking) only.
    await Inventory.updateOne(
      { _id: inventoryId, "sale.channel": sale.channel, "sale.orderId": sale.orderId, "sale.lineItemId": sale.lineItemId },
      { $set: flattenForSet("sale", details) }
    );
    return "refreshed";
  }

  // insufficient / removed: stock wasn't there — the part was sold twice.
  await recordConflict(inventoryId, sale);
  return "conflict";
}

/**
 * A completed cancellation puts back exactly what that order deducted, once.
 * Nothing is restored if the order never deducted stock.
 * @returns {Promise<number>} parts restored
 */
async function releaseOrder(channel, orderId, reason) {
  const InventoryTransaction = require("../models/InventoryTransaction.model");
  const sales = await InventoryTransaction.find({
    source: SALE_SOURCE[channel],
    orderId: String(orderId),
    status: "applied",
  }).lean();

  let released = 0;
  for (const tx of sales) {
    const r = await ledger.restore({
      inventoryId: tx.inventoryId,
      quantity: tx.quantity,
      key: `${channel}-cancel:${tx.key}`,
      source: CANCEL_SOURCE[channel],
      channel,
      orderId: tx.orderId,
      orderLineItemId: tx.orderLineItemId,
      listingId: tx.listingId,
      uncountSale: true,
      clearSaleOfOrder: orderId,
      reason: `order ${reason}`,
    });
    if (r.outcome === "applied") released += 1;
  }

  // Parts marked sold before the ledger existed (no sale transaction).
  const legacy = await Inventory.find({
    saleStatus: "sold",
    "sale.channel": channel,
    "sale.orderId": String(orderId),
  })
    .select("_id sale")
    .lean();
  for (const part of legacy) {
    const hasTx = sales.some((tx) => String(tx.inventoryId) === String(part._id));
    if (hasTx) continue;
    const r = await ledger.restore({
      inventoryId: part._id,
      quantity: 1,
      key: `${channel}-cancel:legacy:${orderId}:${part._id}`,
      source: CANCEL_SOURCE[channel],
      channel,
      orderId: String(orderId),
      orderLineItemId: part.sale?.lineItemId,
      uncountSale: true,
      clearSaleOfOrder: orderId,
      reason: `order ${reason} (sold before ledger)`,
    });
    if (r.outcome === "applied") released += 1;
  }

  if (released) {
    console.log(`${LOG_PREFIX} ${channel} order ${orderId} ${reason} → ${released} part(s) back to available`);
    await logAction({
      action: "marketplace_sale_released",
      status: "success",
      platform: channel,
      entityType: "inventory",
      message: `${channel} order ${orderId} ${reason}: ${released} part(s) returned to available stock`,
      metadata: { orderId },
    }).catch(() => {});
  }
  return released;
}


const emptyResult = () => ({ sold: 0, refreshed: 0, released: 0, conflicts: 0, unmatched: [] });

// ─── eBay ───────────────────────────────────────────────────────────────────

/**
 * Map an eBay order line to exactly one CRM part. Never guesses: if a SKU or
 * eBay item id points at more than one part, the line is left unmatched
 * (reason "ambiguous") and NO stock is deducted.
 * @returns {Promise<{id: *|null, reason?: string}>}
 */
async function findInventoryForEbayLine(line) {
  const sku = clean(line.sku);
  if (sku && isObjectIdString(sku)) {
    const byId = await Inventory.findById(sku).select("_id").lean();
    if (byId) return { id: byId._id };
  }
  const unique = async (filter, label) => {
    const hits = await Inventory.find(filter).select("_id").limit(2).lean();
    if (hits.length > 1) return { id: null, reason: `ambiguous: several CRM parts share this ${label}` };
    return hits.length ? { id: hits[0]._id } : null;
  };
  if (sku) {
    const r = await unique({ ebaySku: sku }, "eBay SKU");
    if (r) return r;
  }
  const itemId = clean(line.legacyItemId);
  if (itemId) {
    const r = await unique({ ebayListingId: itemId }, "eBay item id");
    if (r) return r;
  }
  return { id: null, reason: "no CRM part with this SKU or eBay item id" };
}

/**
 * Apply one eBay Fulfillment API order to CRM inventory.
 * @param {Object} order - raw eBay order
 * @param {Object} [orderDoc] - the CRM Order document saved for it (links + buyer details)
 */
async function applyEbayOrder(order, orderDoc) {
  const result = emptyResult();
  if (!order?.orderId) return result;

  const { orderStatus, paymentStatus, shippingStatus } = normalizeOrderStatuses(order);
  if (orderStatus === "Cancelled") {
    result.released = await releaseOrder("ebay", order.orderId, "was cancelled");
    return result;
  }

  const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
  const addr = shipTo.contactAddress || {};
  const orderLevel = {
    channel: "ebay",
    orderId: order.orderId,
    orderNumber: clean(order.legacyOrderId) || order.orderId,
    soldAt: toDate(order.creationDate),
    currency: clean(order.pricingSummary?.total?.currency),
    orderStatus,
    paymentStatus,
    shippingStatus,
    trackingNumber: clean(orderDoc?.trackingNumber),
    carrier: clean(orderDoc?.carrier),
    buyerName: clean(shipTo.fullName) || clean(orderDoc?.customerName),
    buyerUsername: clean(order.buyer?.username),
    buyerEmail: clean(shipTo.email) || clean(orderDoc?.buyerEmail),
    buyerPhone: clean(shipTo.primaryPhone?.phoneNumber) || clean(orderDoc?.customerPhone),
    shippingAddress: {
      name: clean(shipTo.fullName),
      line1: clean(addr.addressLine1),
      line2: clean(addr.addressLine2),
      city: clean(addr.city),
      state: clean(addr.stateOrProvince),
      postalCode: clean(addr.postalCode),
      country: clean(addr.countryCode),
    },
    orderRef: orderDoc?._id,
    customerId: orderDoc?.customerId || undefined,
  };

  const { refundStatus } = normalizeOrderStatuses(order);
  const refunded = /refund/i.test(String(refundStatus || "")) && !/not refunded/i.test(String(refundStatus));

  for (const line of order.lineItems || []) {
    const match = await findInventoryForEbayLine(line);
    const inventoryId = match.id;
    if (!inventoryId) {
      result.unmatched.push({
        reason: match.reason,
        channel: "ebay",
        orderId: order.orderId,
        orderNumber: orderLevel.orderNumber,
        sku: clean(line.sku) || null,
        listingId: clean(line.legacyItemId) || null,
        title: clean(line.title) || null,
        quantity: line.quantity || 1,
        soldAt: orderLevel.soldAt || null,
      });
      continue;
    }
    const outcome = await markPartSold(inventoryId, {
      ...orderLevel,
      lineItemId: String(line.lineItemId || line.legacyItemId || ""),
      quantity: Number(line.quantity) || 1,
      price: toNumber(line.lineItemCost?.value ?? line.total?.value),
      currency: clean(line.lineItemCost?.currency) || orderLevel.currency,
      listingId: clean(line.legacyItemId),
      listingTitle: clean(line.title),
    });
    if (outcome === "sold") result.sold += 1;
    else if (outcome === "refreshed") result.refreshed += 1;
    else if (outcome === "conflict") result.conflicts += 1;

    // A refund (full or partial) NEVER restocks — the part comes back only
    // when staff receive and approve a return. Recorded once for the audit trail.
    if (refunded) {
      await ledger.recordInfo({
        key: `ebay-refund:${order.orderId}:${line.lineItemId}:${refundStatus}`,
        inventoryId,
        source: "EBAY_RETURN",
        channel: "ebay",
        orderId: order.orderId,
        orderLineItemId: String(line.lineItemId || ""),
        reason: `${refundStatus} — stock unchanged until the part is returned and passes inspection`,
      });
    }
  }
  return result;
}

// ─── Wix ────────────────────────────────────────────────────────────────────

function wixHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: process.env.WIX_API_KEY,
    "wix-site-id": process.env.WIX_SITE_ID,
  };
}

function wixAmount(price) {
  return toNumber(price?.amount ?? price?.value);
}

/**
 * Apply one Wix eCommerce order to CRM inventory.
 * Wix status: APPROVED = placed order (sold); CANCELED/REJECTED = cancelled;
 * INITIALIZED/PENDING = checkout not finished yet (ignored).
 */
async function applyWixOrder(order) {
  const result = emptyResult();
  if (!order?.id) return result;

  const status = String(order.status || "").toUpperCase();
  if (status === "CANCELED" || status === "CANCELLED" || status === "REJECTED") {
    result.released = await releaseOrder("wix", order.id, "was cancelled");
    return result;
  }
  if (status !== "APPROVED") return result;

  const billing = order.billingInfo?.contactDetails || {};
  const shipping = order.shippingInfo?.logistics?.shippingDestination || {};
  const shipContact = shipping.contactDetails || {};
  const shipAddr = shipping.address || order.billingInfo?.address || {};
  const nameOf = (c) => clean([c.firstName, c.lastName].filter(Boolean).join(" "));
  const fulfillment = String(order.fulfillmentStatus || "").toUpperCase();

  const orderLevel = {
    channel: "wix",
    orderId: order.id,
    orderNumber: clean(order.number) || order.id,
    soldAt: toDate(order.purchasedDate || order.createdDate),
    currency: clean(order.currency),
    orderStatus: "Approved",
    paymentStatus: clean(order.paymentStatus),
    shippingStatus: fulfillment === "FULFILLED" ? "Fulfilled" : fulfillment === "PARTIALLY_FULFILLED" ? "Partially fulfilled" : "Not fulfilled",
    buyerName: nameOf(shipContact) || nameOf(billing),
    buyerEmail: clean(order.buyerInfo?.email),
    buyerPhone: clean(shipContact.phone) || clean(billing.phone),
    shippingAddress: {
      name: nameOf(shipContact),
      line1: clean(shipAddr.addressLine1 || shipAddr.addressLine),
      line2: clean(shipAddr.addressLine2),
      city: clean(shipAddr.city),
      state: clean(shipAddr.subdivisionFullname || shipAddr.subdivision),
      postalCode: clean(shipAddr.postalCode),
      country: clean(shipAddr.countryFullname || shipAddr.country),
    },
  };

  for (const line of order.lineItems || []) {
    const productId = clean(line.catalogReference?.catalogItemId);
    const quantity = Math.max(1, parseInt(line.quantity, 10) || 1);
    const title = clean(line.productName?.original || line.productName?.translated);
    const unmatchedBase = {
      channel: "wix",
      orderId: order.id,
      orderNumber: orderLevel.orderNumber,
      sku: clean(line.physicalProperties?.sku) || null,
      listingId: productId || null,
      title: title || null,
      soldAt: orderLevel.soldAt || null,
    };

    if (!productId) {
      result.unmatched.push({ ...unmatchedBase, quantity });
      continue;
    }

    const lineTotal = wixAmount(line.totalPriceAfterTax) ?? wixAmount(line.totalPriceBeforeTax);
    const unitPrice = wixAmount(line.price) ?? (lineTotal !== undefined ? lineTotal / quantity : undefined);
    const lineSale = {
      ...orderLevel,
      lineItemId: String(line.id || productId),
      quantity: 1, // each CRM part is one unit
      price: unitPrice,
      listingId: productId,
      listingTitle: title,
    };

    const group = await Inventory.find({ wixProductId: productId })
      .select("_id saleStatus quantityAvailable isDeleted createdAt")
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (!group.length) {
      result.unmatched.push({ ...unmatchedBase, quantity });
      continue;
    }

    // One ledger key per unit of the line ("…:1", "…:2"), so a re-read of the
    // same order never deducts twice, whichever part each unit landed on.
    const InventoryTransaction = require("../models/InventoryTransaction.model");
    let short = 0;
    for (let unit = 1; unit <= quantity; unit += 1) {
      const key = saleKey(lineSale, unit);
      const done = await InventoryTransaction.findOne({ key, status: "applied" }).select("inventoryId").lean();
      if (done) {
        const outcome = await markPartSold(done.inventoryId, lineSale, { unit, quantity: 1 });
        if (outcome === "refreshed") result.refreshed += 1;
        continue;
      }

      let placed = false;
      for (const p of group) {
        if (p.isDeleted || (p.quantityAvailable ?? 1) <= 0) continue;
        const r = await ledger.deduct({
          inventoryId: p._id,
          quantity: 1,
          key,
          source: "WIX_SALE",
          channel: "wix",
          orderId: lineSale.orderId,
          orderLineItemId: lineSale.lineItemId,
          listingId: lineSale.listingId,
          countAsSale: true,
          sale: compact({ ...lineSale, lastSyncedAt: new Date() }),
          details: { orderNumber: lineSale.orderNumber, price: lineSale.price, unit },
        });
        if (r.outcome === "applied") {
          result.sold += 1;
          placed = true;
          p.quantityAvailable = r.newQuantity;
          break;
        }
        if (r.outcome === "duplicate") {
          result.refreshed += 1;
          placed = true;
          break;
        }
        p.quantityAvailable = 0; // insufficient/removed → try the next part
      }
      if (!placed) short += 1;
    }

    if (short > 0) {
      // Wix sold more units than the CRM has in stock for this product.
      result.unmatched.push({ ...unmatchedBase, quantity: short, reason: "not enough CRM stock for this Wix product" });
      if (await recordConflict(group[0]._id, lineSale)) result.conflicts += 1;
    }
  }
  return result;
}

async function fetchWixOrdersSince(since) {
  const orders = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Wix rule: when a cursor is passed, filter/sort must not be sent again.
    const search = cursor
      ? { cursorPaging: { limit: WIX_PAGE_SIZE, cursor } }
      : {
          filter: { updatedDate: { $gte: since.toISOString() } },
          sort: [{ fieldName: "updatedDate", order: "ASC" }],
          cursorPaging: { limit: WIX_PAGE_SIZE },
        };
    const res = await axios.post(WIX_ORDERS_SEARCH_URL, { search }, { headers: wixHeaders(), timeout: 30000 });
    orders.push(...(res.data?.orders || []));
    const meta = res.data?.metadata || {};
    cursor = meta.cursors?.next || null;
    if (!meta.hasNext || !cursor) return { orders, complete: true };
  }
  return { orders, complete: false };
}

// ─── sync runs ──────────────────────────────────────────────────────────────

async function windowStart(channel) {
  const state = await MarketplaceSaleSync.findById(channel).lean();
  if (state?.lastSuccessAt) return new Date(new Date(state.lastSuccessAt).getTime() - OVERLAP_MS);
  return new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

function addInto(total, part) {
  total.sold += part.sold;
  total.refreshed += part.refreshed;
  total.released += part.released;
  total.conflicts += part.conflicts;
  total.unmatched.push(...part.unmatched);
}

async function recordRun(channel, startedAt, { status, error = null, summary = {}, unmatched = [], advance }) {
  const $set = {
    lastRunAt: startedAt,
    lastStatus: status,
    lastError: error,
    lastSummary: summary,
    unmatched: unmatched.slice(0, MAX_UNMATCHED_STORED),
  };
  if (advance) $set.lastSuccessAt = startedAt;
  await MarketplaceSaleSync.updateOne({ _id: channel }, { $set }, { upsert: true });
}

/**
 * Pull eBay orders changed since the last run, store them in the Orders
 * module (same path as the manual "Sync Orders") and update sold status.
 */
async function syncEbaySales() {
  const startedAt = new Date();
  const total = emptyResult();
  // Lazy require: the adapter itself requires this service.
  const ebayAdapter = require("./adapters/ebayAdapter");

  try {
    const account = await IntegrationAccount.findOne({ platform: "ebay", isActive: true }).sort({ createdAt: -1 });
    if (!account || !account.accessToken) {
      await recordRun("ebay", startedAt, { status: "skipped", error: "eBay is not connected", advance: false });
      return { channel: "ebay", skipped: "eBay is not connected" };
    }
    if (account.isTokenExpired) {
      if (!account.refreshToken) {
        await recordRun("ebay", startedAt, { status: "skipped", error: "eBay token expired — reconnect eBay", advance: false });
        return { channel: "ebay", skipped: "eBay token expired" };
      }
      await ebayAdapter.refreshToken(account);
    }

    const since = await windowStart("ebay");
    const limit = 50;
    let offset = 0;
    let orders = 0;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await ebayAdapter.client.get(account.accessToken, "/sell/fulfillment/v1/order", {
        limit,
        offset,
        filter: `lastmodifieddate:[${since.toISOString()}..]`,
      });
      for (const order of res?.orders || []) {
        orders += 1;
        // _upsertOrder saves the CRM Order and (via its hook) applies the sale.
        const saved = await ebayAdapter._upsertOrder(order, account);
        const applied = saved?.$locals?.saleResult;
        if (applied) addInto(total, applied);
      }
      offset += limit;
      if (!res?.total || offset >= res.total) {
        complete = true;
        break;
      }
    }

    const summary = { orders, sold: total.sold, refreshed: total.refreshed, released: total.released, conflicts: total.conflicts, unmatched: total.unmatched.length, since };
    await recordRun("ebay", startedAt, {
      status: complete ? "success" : "failed",
      error: complete ? null : `Stopped after ${MAX_PAGES} pages — will continue next run`,
      summary,
      unmatched: total.unmatched,
      advance: complete,
    });
    return { channel: "ebay", ...summary };
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`${LOG_PREFIX} eBay sync failed:`, message);
    await recordRun("ebay", startedAt, { status: "failed", error: message, advance: false }).catch(() => {});
    return { channel: "ebay", error: message };
  }
}

/** Pull Wix orders changed since the last run and update sold status. */
async function syncWixSales() {
  const startedAt = new Date();
  const total = emptyResult();
  try {
    if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
      await recordRun("wix", startedAt, { status: "skipped", error: "WIX_API_KEY / WIX_SITE_ID are not set", advance: false });
      return { channel: "wix", skipped: "Wix credentials not set" };
    }

    const since = await windowStart("wix");
    const { orders, complete } = await fetchWixOrdersSince(since);
    for (const order of orders) {
      try {
        addInto(total, await applyWixOrder(order));
      } catch (err) {
        console.error(`${LOG_PREFIX} Wix order ${order?.number || order?.id} failed:`, err.message);
      }
    }

    const summary = { orders: orders.length, sold: total.sold, refreshed: total.refreshed, released: total.released, conflicts: total.conflicts, unmatched: total.unmatched.length, since };
    await recordRun("wix", startedAt, {
      status: complete ? "success" : "failed",
      error: complete ? null : `Stopped after ${MAX_PAGES} pages — will continue next run`,
      summary,
      unmatched: total.unmatched,
      advance: complete,
    });
    return { channel: "wix", ...summary };
  } catch (err) {
    const status = err?.response?.status;
    const detail = err?.response?.data?.message || err?.message || String(err);
    const message =
      status === 401 || status === 403
        ? `Wix refused access to orders (${status}). The Wix API key needs the "Wix eCommerce – Read Orders" permission. ${detail}`
        : detail;
    console.error(`${LOG_PREFIX} Wix sync failed:`, message);
    await recordRun("wix", startedAt, { status: "failed", error: message, advance: false }).catch(() => {});
    return { channel: "wix", error: message };
  }
}

/** Run both channels; one failing never stops the other. */
// ─── eBay returns (Post-Order API) ──────────────────────────────────────────

const RETURN_LOOKBACK_DAYS = 90;
const STAFF_RETURN_STATES = ["received", "inspection_passed", "inspection_failed"];

/** eBay return state → CRM return status (staff decide received/inspection). */
function mapReturnState(state) {
  const s = String(state || "").toUpperCase();
  if (s.includes("CLOSED")) return "closed";
  if (s.includes("DELIVERED")) return "delivered";
  if (s.includes("SHIP") || s.includes("TRANSIT")) return "in_transit";
  return "requested";
}

/**
 * Read eBay returns from the last 90 days and record their state on the sold
 * part (Inventory.returnInfo). NEVER changes stock: a part goes back into
 * stock only when staff mark it received and it passes inspection.
 * Auth header prefix defaults to "IAF" (Post-Order API reference); set
 * EBAY_POST_ORDER_AUTH_PREFIX=Bearer if your account needs it.
 */
async function syncEbayReturns() {
  const startedAt = new Date();
  const ebayAdapter = require("./adapters/ebayAdapter");
  const InventoryTransaction = require("../models/InventoryTransaction.model");
  const summary = { returns: 0, updated: 0, unmatched: 0 };
  const unmatched = [];
  try {
    const account = await IntegrationAccount.findOne({ platform: "ebay", isActive: true }).sort({ createdAt: -1 });
    if (!account || !account.accessToken) {
      await recordRun("ebay-returns", startedAt, { status: "skipped", error: "eBay is not connected", advance: false });
      return { channel: "ebay-returns", skipped: "eBay is not connected" };
    }
    if (account.isTokenExpired) {
      if (!account.refreshToken) {
        await recordRun("ebay-returns", startedAt, { status: "skipped", error: "eBay token expired — reconnect eBay", advance: false });
        return { channel: "ebay-returns", skipped: "eBay token expired" };
      }
      await ebayAdapter.refreshToken(account);
    }

    const from = new Date(Date.now() - RETURN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prefix = process.env.EBAY_POST_ORDER_AUTH_PREFIX || "IAF";
    const baseUrl = ebayAdapter.client.getBaseUrl();
    const limit = 200;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await axios.get(`${baseUrl}/post-order/v2/return/search`, {
        // Post-Order search pages by page number in `offset` (1-based).
        params: { creation_date_range_from: from, limit, offset: page + 1 },
        headers: {
          Authorization: `${prefix} ${account.accessToken}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
        },
        timeout: 30000,
      });
      const members = res.data?.members || [];
      for (const m of members) {
        summary.returns += 1;
        const returnId = clean(m.returnId);
        const orderId = clean(m.orderId);
        const itemId = clean(m.creationInfo?.item?.itemId);
        const state = clean(m.state) || clean(m.status);
        if (!returnId) continue;

        let inventoryId = null;
        if (orderId) {
          const tx = await InventoryTransaction.findOne({ source: "EBAY_SALE", orderId, status: "applied" }).select("inventoryId").lean();
          inventoryId = tx?.inventoryId || null;
        }
        if (!inventoryId && itemId) {
          const hits = await Inventory.find({ ebayListingId: itemId }).select("_id").limit(2).lean();
          if (hits.length === 1) inventoryId = hits[0]._id;
        }
        if (!inventoryId) {
          summary.unmatched += 1;
          unmatched.push({ channel: "ebay", returnId, orderId, listingId: itemId, state, reason: "return not matched to a CRM part" });
          continue;
        }

        const part = await Inventory.findById(inventoryId).select("returnInfo").lean();
        const now = new Date();
        const staffOwned = part?.returnInfo?.returnId === returnId && STAFF_RETURN_STATES.includes(part.returnInfo.status);
        const refundStatus = clean(m.sellerTotalRefund?.estimatedRefundAmount?.value)
          ? `refund ${m.sellerTotalRefund.estimatedRefundAmount.value}`
          : clean(m.refundInfo?.refundStatus) || clean(m.currentType);
        const $set = staffOwned
          ? { "returnInfo.ebayState": state, "returnInfo.refundStatus": refundStatus, "returnInfo.updatedAt": now }
          : {
              returnInfo: compact({
                channel: "ebay",
                returnId,
                orderId,
                status: mapReturnState(state),
                ebayState: state,
                refundStatus,
                requestedAt: toDate(m.creationInfo?.creationDate?.value || m.creationInfo?.creationDate) || now,
                updatedAt: now,
              }),
            };
        await Inventory.updateOne({ _id: inventoryId }, { $set });
        summary.updated += 1;
        await ledger.recordInfo({
          key: `ebay-return:${returnId}:${state}`,
          inventoryId,
          source: "EBAY_RETURN",
          channel: "ebay",
          orderId,
          returnId,
          reason: `eBay return ${state} — stock unchanged until received and approved for resale`,
        });
      }
      const total = Number(res.data?.total ?? res.data?.paginationOutput?.totalEntries ?? 0);
      if (!members.length || (page + 1) * limit >= total) break;
    }

    await recordRun("ebay-returns", startedAt, { status: "success", summary, unmatched, advance: true });
    if (summary.updated) require("../utils/realtime").invalidate("inventorySync", "soldProducts");
    return { channel: "ebay-returns", ...summary };
  } catch (err) {
    const status = err?.response?.status;
    const message =
      status === 401 || status === 403
        ? `eBay refused access to returns (${status}). Check the Post-Order API auth prefix (EBAY_POST_ORDER_AUTH_PREFIX) and the token's scopes.`
        : err?.response?.data?.error?.[0]?.message || err.message || String(err);
    console.error(`${LOG_PREFIX} eBay returns sync failed:`, message);
    await recordRun("ebay-returns", startedAt, { status: "failed", error: message, advance: false }).catch(() => {});
    return { channel: "ebay-returns", error: message };
  }
}

async function syncAllMarketplaceSales() {
  const ebay = await syncEbaySales();
  const wix = await syncWixSales();
  const ebayReturns = await syncEbayReturns();
  return { ebay, wix, ebayReturns };
}

module.exports = {
  SALE_CHANNELS,
  markPartSold,
  releaseOrder,
  applyEbayOrder,
  applyWixOrder,
  syncEbaySales,
  syncWixSales,
  syncEbayReturns,
  syncAllMarketplaceSales,
};
