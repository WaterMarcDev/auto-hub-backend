/**
 * Thin orchestration layer for the eBay catalog-sync API endpoints
 * (manual run/retry/status). Delegates ALL actual sync business logic to
 * the existing, already-hardened services/ebay/ebayCatalogSync.service.js
 * — untouched by this migration, and must stay that way. This file only
 * extracts the controller-level orchestration (lock acquire/release,
 * looping over retry IDs, formatting the status payload) that previously
 * lived inline in controllers/ebayCatalogSync.controller.js.
 */
const { syncCatalog, syncSingleProduct } = require("./ebay/ebayCatalogSync.service");
const ebaySyncRunRepository = require("../repositories/ebaySyncRun.repository");
const inventoryRepository = require("../repositories/inventory.repository");
const ebayConfig = require("../config/ebayCatalogConfig");

/**
 * POST /api/ebay/catalog-sync/run
 */
async function runFullSync({ dryRun, maxProducts }) {
  // Acquire lock for non-dry-run operations
  let run = null;
  if (!dryRun) {
    run = await ebaySyncRunRepository.acquireLock("manual");
    if (!run) {
      const err = new Error(
        "A synchronization run is already in progress. Wait for it to complete or try again later."
      );
      err.statusCode = 409;
      throw err;
    }
  }

  try {
    const result = await syncCatalog({
      dryRun,
      maxProducts,
      trigger: dryRun ? "manual" : "manual",
    });

    if (!dryRun && run) {
      if (result?.summary?.error) {
        await ebaySyncRunRepository.releaseLock(run, "failed", {
          ...result.summary,
          error: result.summary.error,
        });
      } else {
        await ebaySyncRunRepository.releaseLock(run, "completed", {
          ...result.summary,
          error: null,
        });
      }
    }

    return result;
  } catch (err) {
    if (!dryRun && run) {
      await ebaySyncRunRepository.releaseLock(run, "failed", {
        error: err.message,
      });
    }
    throw err;
  }
}

/**
 * POST /api/ebay/catalog-sync/run/:id
 */
async function runSingleSync(id, dryRun) {
  return syncSingleProduct(id, dryRun);
}

/**
 * POST /api/ebay/catalog-sync/retry-failed
 *
 * Products that are permanently excluded (A1/A2/Windshield) are skipped
 * without re-invoking the sync engine — retrying them can never succeed
 * and would just waste a cycle; the exclusion is still authoritative and
 * re-checked by mapProduct on every other path, this is purely an
 * efficiency short-circuit here.
 */
async function retryFailedProducts(productIds) {
  const results = [];
  for (const id of productIds) {
    try {
      const existing = await inventoryRepository
        .findById(id)
        .select("ebaySyncStatus")
        .lean();
      if (existing && existing.ebaySyncStatus === "EXCLUDED") {
        results.push({
          productId: id,
          success: false,
          skipped: true,
          error: "Permanently excluded (A1/A2/Windshield) — not retried",
        });
        continue;
      }

      const result = await syncSingleProduct(id);
      results.push({ productId: id, success: true, data: result });
    } catch (err) {
      results.push({ productId: id, success: false, error: err.message });
    }
  }

  return {
    results,
    totalRetried: results.length,
    totalSucceeded: results.filter((r) => r.success).length,
    totalFailed: results.filter((r) => !r.success).length,
  };
}

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

/**
 * GET /api/ebay/catalog-sync/status
 */
async function getSyncStatus() {
  const latestRun = await ebaySyncRunRepository.getLatestRun();

  return {
    configured: ebayConfig.isCatalogConfigured(),
    missingConfiguration: ebayConfig.getMissingConfiguration(),
    environment: ebayConfig.EBAY_ENVIRONMENT,
    lastRun: latestRun || null,
    nextScheduledAt: getNextScheduledTime(),
  };
}

module.exports = {
  runFullSync,
  runSingleSync,
  retryFailedProducts,
  getSyncStatus,
};
