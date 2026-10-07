/**
 * eBay Catalog Sync Controller
 *
 * API endpoints for manual/retry/dry-run/status operations on the
 * CRM → eBay catalog synchronization pipeline.
 *
 * All endpoints use the same underlying ebayCatalogSync.service.js
 * that the 6-hour scheduled job uses.
 */
const { syncCatalog, syncSingleProduct } = require("../services/ebay/ebayCatalogSync.service");
const EbaySyncRun = require("../models/EbaySyncRun.model");
const Inventory = require("../models/Inventory.model");
const MarketplaceListing = require("../models/MarketplaceListing.model");
const { WIX_EXCLUDED_PART_NAMES } = require("../utils/wixExportExclusions");
const ebayConfig = require("../config/ebayCatalogConfig");

/**
 * POST /api/ebay/catalog-sync/run
 * Run full catalog synchronization (or dry run).
 */
exports.runFullSync = async (req, res) => {
  try {
    const dryRun = req.query.dryRun === "true";
    const maxProducts = req.query.max ? parseInt(req.query.max, 10) || 0 : ebayConfig.EBAY_SYNC_MAX_PRODUCTS || 0;

    const runSync = (signal) =>
      syncCatalog({
        dryRun,
        maxProducts,
        trigger: dryRun ? "manual" : "manual",
        signal,
      });

    // Dry runs never mutate eBay and never take the global lock (unchanged
    // behaviour). Non-dry runs take the shared eBay lease lock.
    if (dryRun) {
      const result = await runSync(null);
      return res.json({ success: true, dryRun, data: result });
    }

    // Centralized acquire → heartbeat → run → ownership-verified release.
    // state.signal aborts if the lease is lost mid-run.
    const outcome = await EbaySyncRun.withEbaySyncLock("manual", (run, state) => runSync(state.signal), {
      jobType: "catalog_push",
    });

    if (!outcome.acquired) {
      if (outcome.code === "SYNC_ALREADY_RUNNING") {
        return res.status(409).json({
          success: false,
          code: "SYNC_ALREADY_RUNNING",
          error: "A synchronization run is already in progress. Wait for it to complete or try again later.",
        });
      }
      // Lock could not be obtained for a non-contention reason (e.g. Mongo down).
      const message = (outcome.error && outcome.error.message) || "Unable to acquire the eBay sync lock.";
      return res.status(500).json({ success: false, code: outcome.code || "LOCK_DATABASE_ERROR", error: message });
    }

    if (outcome.code === "LOCK_LOST") {
      return res.status(409).json({
        success: false,
        code: "LOCK_LOST",
        error: "The eBay sync lease was lost while the run was executing; the run was aborted.",
      });
    }

    res.json({
      success: true,
      dryRun,
      data: outcome.result,
    });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error running full sync:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/ebay/catalog-sync/run/:id
 * Synchronize a single Inventory product by ID.
 */
exports.runSingleSync = async (req, res) => {
  try {
    const { id } = req.params;
    const dryRun = req.query.dryRun === "true";

    const result = await syncSingleProduct(id, dryRun);

    res.json({
      success: true,
      dryRun,
      data: result,
    });
  } catch (err) {
    console.error(`[EBAY_CATALOG_SYNC] Error syncing product ${req.params.id}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/ebay/catalog-sync/retry-failed
 * Retry previously failed products.
 * Requires a list of product IDs to retry.
 */
exports.retryFailed = async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ success: false, error: "productIds array is required" });
    }

    // Process each failed product. Products that are permanently excluded
    // (A1/A2/Windshield) are skipped without re-invoking the sync engine —
    // retrying them can never succeed and would just waste a cycle; the
    // exclusion is still authoritative and re-checked by mapProduct on
    // every other path, this is purely an efficiency short-circuit here.
    const results = [];
    for (const id of productIds) {
      try {
        const existing = await Inventory.findById(id).select("ebaySyncStatus").lean();
        if (existing && existing.ebaySyncStatus === "EXCLUDED") {
          results.push({ productId: id, success: false, skipped: true, error: "Permanently excluded (A1/A2/Windshield) — not retried" });
          continue;
        }

        const result = await syncSingleProduct(id);
        results.push({ productId: id, success: true, data: result });
      } catch (err) {
        results.push({ productId: id, success: false, error: err.message });
      }
    }

    res.json({
      success: true,
      results,
      totalRetried: results.length,
      totalSucceeded: results.filter((r) => r.success).length,
      totalFailed: results.filter((r) => !r.success).length,
    });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error retrying failed products:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Same rule as utils/ebayExportExclusions.js (trimmed, case-insensitive
// exact part name), expressed as a regex so it can run inside MongoDB.
const EXCLUDED_PART_NAME_REGEX = `^(${[...WIX_EXCLUDED_PART_NAMES].map(escapeRegex).join("|")})$`;

/**
 * Current catalog totals, computed from the Inventory collection with the
 * same rules the catalog sync uses — NOT from the last run's counters,
 * which only describe what that single run did (a run that finds nothing
 * new reports Published 0 even when thousands of products are live).
 *
 *   discovered = parts the sync looks at (every non-deleted Inventory item)
 *   excluded   = discovered parts never sent to eBay (A1 / A2 / Windshield)
 *   created    = live listings created by the CRM   (ebaySyncStatus PUBLISHED)
 *   updated    = live listings revised by the CRM   (ebaySyncStatus UPDATED)
 *   published  = created + updated (every product live on eBay from the CRM)
 *   failed     = products whose last sync attempt failed (FAILED)
 *   notSynced  = everything else (not attempted yet)
 *   liveOnEbay = eBay listings found by the eBay → CRM listing import
 *                (Marketplace Listing), which can also contain listings
 *                created outside the CRM
 */
async function getCatalogTotals() {
  const isExcluded = {
    $regexMatch: {
      input: { $trim: { input: { $toString: { $ifNull: ["$partName", ""] } } } },
      regex: EXCLUDED_PART_NAME_REGEX,
      options: "i",
    },
  };

  const [row] = await Inventory.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    {
      $group: {
        _id: null,
        discovered: { $sum: 1 },
        excluded: { $sum: { $cond: [isExcluded, 1, 0] } },
        created: { $sum: { $cond: [{ $and: [{ $not: [isExcluded] }, { $eq: ["$ebaySyncStatus", "PUBLISHED"] }] }, 1, 0] } },
        updated: { $sum: { $cond: [{ $and: [{ $not: [isExcluded] }, { $eq: ["$ebaySyncStatus", "UPDATED"] }] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $and: [{ $not: [isExcluded] }, { $eq: ["$ebaySyncStatus", "FAILED"] }] }, 1, 0] } },
      },
    },
  ]);

  const totals = row || { discovered: 0, excluded: 0, created: 0, updated: 0, failed: 0 };
  const published = totals.created + totals.updated;
  const liveOnEbay = await MarketplaceListing.countDocuments({ marketplace: "ebay" });

  return {
    discovered: totals.discovered,
    excluded: totals.excluded,
    published,
    created: totals.created,
    updated: totals.updated,
    failed: totals.failed,
    notSynced: totals.discovered - totals.excluded - published - totals.failed,
    liveOnEbay,
  };
}

/**
 * GET /api/ebay/catalog-sync/status
 * Get the current and last sync status.
 */
exports.getSyncStatus = async (req, res) => {
  try {
    // The catalog push and the eBay → CRM listing reconciliation share the
    // EbaySyncRun collection; lastRun must only ever be a catalog push run.
    const [latestRun, latestReconcileRun, catalogTotals] = await Promise.all([
      EbaySyncRun.getLatestRun("catalog_push"),
      EbaySyncRun.getLatestRun("listing_reconcile"),
      getCatalogTotals(),
    ]);

    const scheduleEnabled = ebayConfig.EBAY_CATALOG_CRON_ENABLED;

    const status = {
      configured: ebayConfig.isCatalogConfigured(),
      missingConfiguration: ebayConfig.getMissingConfiguration(),
      environment: ebayConfig.EBAY_ENVIRONMENT,
      catalogTotals,
      lastRun: latestRun || null,
      scheduleEnabled,
      nextScheduledAt: scheduleEnabled ? getNextScheduledTime() : null,
      lastReconcileRun: latestReconcileRun
        ? {
            status: latestReconcileRun.status,
            startedAt: latestReconcileRun.startedAt,
            completedAt: latestReconcileRun.completedAt,
            totalDiscovered: latestReconcileRun.totalDiscovered,
            totalCreated: latestReconcileRun.totalCreated,
            totalUpdated: latestReconcileRun.totalUpdated,
            error: latestReconcileRun.error,
          }
        : null,
    };

    res.json({ success: true, data: status });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error getting status:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/** Statuses a product can hold once the catalog sync has processed it. */
const PRODUCT_SYNC_STATUSES = ["PUBLISHED", "UPDATED", "FAILED", "EXCLUDED", "SKIPPED", "VALIDATING", "NOT_SYNCED"];
const PRODUCTS_MAX_PAGE_SIZE = 100;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEbayListingUrl(listingId) {
  if (!listingId) return null;
  const host = ebayConfig.EBAY_ENVIRONMENT === "sandbox" ? "www.sandbox.ebay.com" : "www.ebay.com";
  return `https://${host}/itm/${encodeURIComponent(listingId)}`;
}

/**
 * GET /api/ebay/catalog-sync/products
 * Paginated list of Inventory products the catalog sync has processed, with
 * their eBay identifiers and per-product sync status.
 *
 * Query: page (1-based), pageSize (max 100), status (one ebaySyncStatus),
 * search (part name, SKU, eBay SKU, offer ID or listing ID).
 * Read-only; served by the { ebaySyncStatus, ebayLastSyncedAt } index.
 */
exports.getSyncedProducts = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), PRODUCTS_MAX_PAGE_SIZE);

    const status = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";
    if (status && !PRODUCT_SYNC_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Use one of: ${PRODUCT_SYNC_STATUSES.join(", ")}` });
    }

    const filter = {
      ebaySyncStatus: status ? status : { $in: PRODUCT_SYNC_STATUSES },
      isDeleted: { $ne: true },
    };

    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { partName: pattern },
        { sku: pattern },
        { ebaySku: pattern },
        { ebayOfferId: pattern },
        { ebayListingId: pattern },
      ];
    }

    const [total, items] = await Promise.all([
      Inventory.countDocuments(filter),
      Inventory.find(filter)
        .select(
          "partName year sku make model trim ebaySku ebayOfferId ebayListingId ebayMarketplaceId ebayCategoryId ebaySyncStatus ebaySyncError ebayLastSyncedAt"
        )
        .populate("make", "name")
        .populate("model", "name")
        .populate("trim", "name")
        .sort({ ebayLastSyncedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
    ]);

    const data = items.map((item) => ({
      _id: item._id,
      partName: item.partName,
      year: item.year ?? null,
      make: item.make?.name ?? null,
      model: item.model?.name ?? null,
      trim: item.trim?.name ?? null,
      sku: item.sku ?? null,
      ebaySku: item.ebaySku,
      ebayOfferId: item.ebayOfferId,
      ebayListingId: item.ebayListingId,
      ebayMarketplaceId: item.ebayMarketplaceId,
      ebayCategoryId: item.ebayCategoryId,
      ebaySyncStatus: item.ebaySyncStatus,
      ebaySyncError: item.ebaySyncError,
      ebayLastSyncedAt: item.ebayLastSyncedAt,
      ebayListingUrl: buildEbayListingUrl(item.ebayListingId),
    }));

    res.json({ success: true, data, total, page, pageSize });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error listing synced products:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Calculate the next scheduled 6-hour run time.
 */
function getNextScheduledTime() {
  const now = new Date();
  const minutes = now.getMinutes();
  const hours = now.getHours();

  // Schedule runs at minute 0 of every 6th hour: 0,6,12,18
  const nextHour = Math.ceil(hours / 6) * 6;
  let nextDate = new Date(now);
  nextDate.setMinutes(0, 0, 0);

  if (nextHour > 23) {
    // Next run is tomorrow at 0
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate.setHours(0);
  } else if (nextHour <= hours && minutes >= 0) {
    // Need the NEXT interval
    if (nextHour + 6 > 23) {
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(0);
    } else {
      nextDate.setHours(nextHour + 6);
    }
  } else {
    nextDate.setHours(nextHour);
  }

  return nextDate.toISOString();
}