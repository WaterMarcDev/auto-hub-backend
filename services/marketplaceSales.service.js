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

// ─── core: mark sold / release ──────────────────────────────────────────────

/**
 * Mark one Inventory part sold by a marketplace order line.
 * @param {string|ObjectId} inventoryId
 * @param {Object} sale - fields of Inventory.sale (channel, orderId, lineItemId required)
 * @returns {Promise<"sold"|"refreshed"|"conflict"|"missing">}
 */
async function markPartSold(inventoryId, sale) {
  const now = new Date();
  const details = compact({ ...sale, lastSyncedAt: now });

  // 1) Available → sold.
  const claimed = await Inventory.findOneAndUpdate(
    { _id: inventoryId, saleStatus: { $ne: "sold" } },
    { $set: { saleStatus: "sold", sale: { ...details, recordedAt: now } } },
    { new: true, projection: { _id: 1 } }
  );
  if (claimed) return "sold";

  // 2) Already sold by this same order line → refresh its details only
  //    (order/payment/shipping status, tracking), keeping recordedAt.
  const refreshed = await Inventory.findOneAndUpdate(
    {
      _id: inventoryId,
      saleStatus: "sold",
      "sale.channel": sale.channel,
      "sale.orderId": sale.orderId,
      "sale.lineItemId": sale.lineItemId,
    },
    { $set: flattenForSet("sale", details) },
    { new: true, projection: { _id: 1 } }
  );
  if (refreshed) return "refreshed";

  // 3) Sold by a DIFFERENT order → the part was sold twice. Record it once.
  const conflict = await Inventory.findOneAndUpdate(
    {
      _id: inventoryId,
      saleStatus: "sold",
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
    { new: true, projection: { _id: 1, partName: 1, vin: 1, sale: 1 } }
  );
  if (conflict) {
    console.warn(
      `${LOG_PREFIX} SOLD TWICE: part ${inventoryId} (${conflict.partName || ""} ${conflict.vin || ""}) ` +
        `already sold on ${conflict.sale?.channel} order ${conflict.sale?.orderNumber || conflict.sale?.orderId}, ` +
        `now also on ${sale.channel} order ${sale.orderNumber || sale.orderId}`
    );
    await logAction({
      action: "marketplace_sale_conflict",
      status: "failure",
      platform: sale.channel,
      entityType: "inventory",
      entityId: String(inventoryId),
      message: `Part sold twice: already sold on ${conflict.sale?.channel} order ${conflict.sale?.orderNumber || conflict.sale?.orderId}, also sold on ${sale.channel} order ${sale.orderNumber || sale.orderId}`,
    }).catch(() => {});
    return "conflict";
  }

  const exists = await Inventory.exists({ _id: inventoryId });
  return exists ? "conflict" : "missing";
}

/**
 * A cancelled order puts the parts it sold back into available stock.
 * @returns {Promise<number>} parts released
 */
async function releaseOrder(channel, orderId, reason) {
  const parts = await Inventory.find({ saleStatus: "sold", "sale.channel": channel, "sale.orderId": orderId })
    .select("_id partName vin")
    .lean();
  if (!parts.length) return 0;

  const result = await Inventory.updateMany(
    { _id: { $in: parts.map((p) => p._id) }, saleStatus: "sold", "sale.channel": channel, "sale.orderId": orderId },
    { $set: { saleStatus: "available", sale: null } }
  );
  const released = result.modifiedCount || 0;
  if (released) {
    console.log(`${LOG_PREFIX} ${channel} order ${orderId} ${reason} → ${released} part(s) back to available`);
    await logAction({
      action: "marketplace_sale_released",
      status: "success",
      platform: channel,
      entityType: "inventory",
      message: `${channel} order ${orderId} ${reason}: ${released} part(s) returned to available stock`,
      metadata: { orderId, parts: parts.map((p) => String(p._id)) },
    }).catch(() => {});
  }
  return released;
}

const emptyResult = () => ({ sold: 0, refreshed: 0, released: 0, conflicts: 0, unmatched: [] });

// ─── eBay ───────────────────────────────────────────────────────────────────

async function findInventoryForEbayLine(line) {
  const sku = clean(line.sku);
  if (sku && isObjectIdString(sku)) {
    const byId = await Inventory.findById(sku).select("_id").lean();
    if (byId) return byId._id;
  }
  if (sku) {
    const bySku = await Inventory.findOne({ ebaySku: sku }).select("_id").lean();
    if (bySku) return bySku._id;
  }
  const itemId = clean(line.legacyItemId);
  if (itemId) {
    const byListing = await Inventory.findOne({ ebayListingId: itemId }).select("_id").lean();
    if (byListing) return byListing._id;
  }
  return null;
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

  for (const line of order.lineItems || []) {
    const inventoryId = await findInventoryForEbayLine(line);
    if (!inventoryId) {
      result.unmatched.push({
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
      .select("_id saleStatus sale isDeleted createdAt")
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (!group.length) {
      result.unmatched.push({ ...unmatchedBase, quantity });
      continue;
    }

    const isThisLine = (p) =>
      p.saleStatus === "sold" &&
      p.sale?.channel === "wix" &&
      p.sale?.orderId === order.id &&
      p.sale?.lineItemId === lineSale.lineItemId;

    // Parts already marked by this line: refresh their details.
    const already = group.filter(isThisLine).slice(0, quantity);
    for (const p of already) {
      const outcome = await markPartSold(p._id, lineSale);
      if (outcome === "refreshed") result.refreshed += 1;
    }

    // Mark more available parts until the line's quantity is covered.
    let needed = quantity - already.length;
    const candidates = group.filter((p) => p.saleStatus !== "sold" && !p.isDeleted);
    for (const p of candidates) {
      if (needed <= 0) break;
      const outcome = await markPartSold(p._id, lineSale);
      if (outcome === "sold") {
        result.sold += 1;
        needed -= 1;
      }
    }

    if (needed > 0) {
      // Wix sold more units than the CRM has available for this product.
      result.unmatched.push({ ...unmatchedBase, quantity: needed, reason: "not enough available CRM parts for this Wix product" });
      if (!already.length && !candidates.length) {
        // Every part of the group is already sold elsewhere → sold twice.
        const outcome = await markPartSold(group[0]._id, lineSale);
        if (outcome === "conflict") result.conflicts += 1;
      }
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
async function syncAllMarketplaceSales() {
  const ebay = await syncEbaySales();
  const wix = await syncWixSales();
  return { ebay, wix };
}

module.exports = {
  SALE_CHANNELS,
  markPartSold,
  releaseOrder,
  applyEbayOrder,
  applyWixOrder,
  syncEbaySales,
  syncWixSales,
  syncAllMarketplaceSales,
};
