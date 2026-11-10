/**
 * CRM ↔ eBay inventory reconciliation (report only — never changes stock).
 *
 * Compares each CRM part that has an eBay listing with the latest snapshot
 * of the seller's ACTIVE eBay listings (MarketplaceListing, refreshed every
 * 30 min by jobs/ebayListingReconcileJob.js — no extra eBay calls here), and
 * collects everything that needs a human:
 *
 *   quantity_mismatch       CRM quantity ≠ eBay quantity
 *   unavailable_but_listed  CRM has 0 (sold/removed) but eBay still offers it
 *   missing_listing         CRM says it is published and in stock, eBay has no active listing
 *   failed_quantity_sync    CRM → eBay quantity push failed/gave up
 *   failed_events           eBay webhook events that failed/gave up
 *   unmatched_order_lines   sold on eBay but matched to no CRM part (or ambiguous)
 *   returns_awaiting_staff  returned parts delivered/received but not inspected
 *   sold_twice              parts sold in more than one order
 *
 * CRM stays the source of truth: a mismatch is reported, then fixed by the
 * normal queue (Retry) or by staff — never by copying eBay's number.
 * Result stored in MarketplaceSaleSync (_id "reconciliation:ebay").
 */
const Inventory = require("../models/Inventory.model");
const MarketplaceListing = require("../models/MarketplaceListing.model");
const MarketplaceEvent = require("../models/MarketplaceEvent.model");
const MarketplaceSaleSync = require("../models/MarketplaceSaleSync.model");
const { targetQuantity } = require("./ebayQuantitySync.service");

const MAX_ITEMS_PER_ISSUE = 100;
const REPORT_ID = "reconciliation:ebay";

async function runReconciliation() {
  const startedAt = new Date();
  const issues = {
    quantity_mismatch: [],
    unavailable_but_listed: [],
    missing_listing: [],
    failed_quantity_sync: [],
    failed_events: [],
    unmatched_order_lines: [],
    returns_awaiting_staff: [],
    sold_twice: [],
  };
  const counts = Object.fromEntries(Object.keys(issues).map((k) => [k, 0]));
  const add = (type, item) => {
    counts[type] += 1;
    if (issues[type].length < MAX_ITEMS_PER_ISSUE) issues[type].push(item);
  };

  const listings = await MarketplaceListing.find({ marketplace: "ebay", marketplaceListingId: { $nin: [null, ""] } })
    .select("marketplaceListingId productSku quantity listingStatus updatedAt")
    .lean();
  const byListingId = new Map(listings.map((l) => [String(l.marketplaceListingId), l]));
  const snapshotAvailable = listings.length > 0;

  const parts = await Inventory.find({ ebayListingId: { $nin: [null, ""] } })
    .select("partName vin sku ebayListingId ebayOfferId ebaySyncStatus quantityAvailable isDeleted saleStatus ebayQuantitySync")
    .lean();

  for (const p of parts) {
    const crmQty = targetQuantity(p);
    const listing = byListingId.get(String(p.ebayListingId));
    const base = { inventoryId: p._id, partName: p.partName, vin: p.vin, listingId: p.ebayListingId, crmQuantity: crmQty };
    const syncBusy = ["pending"].includes(p.ebayQuantitySync?.status);

    if (listing) {
      const ebayQty = Number(listing.quantity ?? 0);
      if (crmQty === 0 && ebayQty > 0 && !syncBusy) add("unavailable_but_listed", { ...base, ebayQuantity: ebayQty });
      else if (crmQty !== ebayQty && !syncBusy) add("quantity_mismatch", { ...base, ebayQuantity: ebayQty });
    } else if (snapshotAvailable && crmQty > 0 && ["PUBLISHED", "UPDATED"].includes(p.ebaySyncStatus)) {
      add("missing_listing", base);
    }
  }

  const failedSync = await Inventory.find({ "ebayQuantitySync.status": { $in: ["failed", "dead"] } })
    .select("partName vin ebayListingId ebayQuantitySync")
    .limit(MAX_ITEMS_PER_ISSUE)
    .lean();
  counts.failed_quantity_sync = await Inventory.countDocuments({ "ebayQuantitySync.status": { $in: ["failed", "dead"] } });
  issues.failed_quantity_sync = failedSync.map((p) => ({
    inventoryId: p._id,
    partName: p.partName,
    vin: p.vin,
    listingId: p.ebayListingId,
    status: p.ebayQuantitySync.status,
    error: p.ebayQuantitySync.lastError,
  }));

  const failedEvents = await MarketplaceEvent.find({ status: { $in: ["failed", "dead"] } })
    .select("eventId topic orderId status lastError attempts")
    .limit(MAX_ITEMS_PER_ISSUE)
    .lean();
  counts.failed_events = await MarketplaceEvent.countDocuments({ status: { $in: ["failed", "dead"] } });
  issues.failed_events = failedEvents;

  const salesState = await MarketplaceSaleSync.findById("ebay").lean();
  for (const u of salesState?.unmatched || []) add("unmatched_order_lines", u);

  const returns = await Inventory.find({ "returnInfo.status": { $in: ["delivered", "received"] } })
    .select("partName vin returnInfo")
    .limit(MAX_ITEMS_PER_ISSUE)
    .lean();
  counts.returns_awaiting_staff = await Inventory.countDocuments({ "returnInfo.status": { $in: ["delivered", "received"] } });
  issues.returns_awaiting_staff = returns.map((p) => ({
    inventoryId: p._id,
    partName: p.partName,
    vin: p.vin,
    returnId: p.returnInfo.returnId,
    status: p.returnInfo.status,
  }));

  const twice = await Inventory.find({ "saleConflicts.0": { $exists: true } })
    .select("partName vin sale.channel sale.orderNumber saleConflicts")
    .limit(MAX_ITEMS_PER_ISSUE)
    .lean();
  counts.sold_twice = await Inventory.countDocuments({ "saleConflicts.0": { $exists: true } });
  issues.sold_twice = twice.map((p) => ({ inventoryId: p._id, partName: p.partName, vin: p.vin, sale: p.sale, conflicts: p.saleConflicts }));

  const summary = {
    partsOnEbay: parts.length,
    activeListingsInSnapshot: listings.length,
    snapshotAvailable,
    totalIssues: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
  };

  await MarketplaceSaleSync.updateOne(
    { _id: REPORT_ID },
    {
      $set: {
        lastRunAt: startedAt,
        lastSuccessAt: startedAt,
        lastStatus: "success",
        lastError: null,
        lastSummary: { ...summary, issues },
        unmatched: [],
      },
    },
    { upsert: true }
  );
  return { ...summary, issues };
}

async function getLatestReport() {
  const doc = await MarketplaceSaleSync.findById(REPORT_ID).lean();
  return doc ? { runAt: doc.lastRunAt, ...doc.lastSummary } : null;
}

module.exports = { runReconciliation, getLatestReport };
