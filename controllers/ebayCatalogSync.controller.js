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
const ebayConfig = require("../config/ebayCatalogConfig");

/**
 * POST /api/ebay/catalog-sync/run
 * Run full catalog synchronization (or dry run).
 */
exports.runFullSync = async (req, res) => {
  try {
    const dryRun = req.query.dryRun === "true";
    const maxProducts = req.query.max ? parseInt(req.query.max, 10) || 0 : ebayConfig.EBAY_SYNC_MAX_PRODUCTS || 0;

    const runSync = () =>
      syncCatalog({
        dryRun,
        maxProducts,
        trigger: dryRun ? "manual" : "manual",
      });

    // Dry runs never mutate eBay and never take the global lock (unchanged
    // behaviour). Non-dry runs take the shared eBay lease lock.
    if (dryRun) {
      const result = await runSync();
      return res.json({ success: true, dryRun, data: result });
    }

    // Centralized acquire → heartbeat → run → ownership-verified release.
    const outcome = await EbaySyncRun.withEbaySyncLock("manual", runSync);

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

/**
 * GET /api/ebay/catalog-sync/status
 * Get the current and last sync status.
 */
exports.getSyncStatus = async (req, res) => {
  try {
    const latestRun = await EbaySyncRun.getLatestRun();

    const status = {
      configured: ebayConfig.isCatalogConfigured(),
      missingConfiguration: ebayConfig.getMissingConfiguration(),
      environment: ebayConfig.EBAY_ENVIRONMENT,
      lastRun: latestRun || null,
      nextScheduledAt: getNextScheduledTime(),
    };

    res.json({ success: true, data: status });
  } catch (err) {
    console.error("[EBAY_CATALOG_SYNC] Error getting status:", err.message);
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