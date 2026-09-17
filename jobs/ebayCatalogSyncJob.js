/**
 * eBay Catalog Sync Job
 *
 * Runs the full CRM → eBay catalog synchronization every 6 hours
 * via node-cron. Uses EbaySyncRun.acquireLock() to prevent overlapping
 * runs. A single run's failure is caught, logged, and never prevents
 * the next scheduled invocation.
 *
 * This is a BACKEND job — it runs from the server process, independent
 * of any frontend page being open or any manual button click.
 *
 * Schedule: runs at minute 0 of every 6th hour (see the cron.schedule
 * call below for the literal expression — not repeated here as a literal
 * cron string because "*" immediately followed by "/" inside a block
 * comment closes the comment early and breaks the whole file).
 */
const cron = require("node-cron");
const { syncCatalog } = require("../services/ebay/ebayCatalogSync.service");
const EbaySyncRun = require("../models/ebaySyncRun.model");

/**
 * Start the 6-hour eBay catalog sync cron job.
 * Called from server.js during startup — failure-tolerant.
 */
function startEbayCatalogSyncJob() {
  console.log("[EBAY_CATALOG_SYNC_JOB] Scheduling every-6-hour sync...");

  cron.schedule("0 */6 * * *", async () => {
    console.log("[EBAY_CATALOG_SYNC_JOB] Triggered (6-hour schedule)");

    // Attempt to acquire the Mongo-backed lock
    const run = await EbaySyncRun.acquireLock("scheduled");
    if (!run) {
      console.log("[EBAY_CATALOG_SYNC_JOB] Skipping — another sync is already running");
      return;
    }

    try {
      const result = await syncCatalog({
        dryRun: false,
        trigger: "scheduled",
      });

      if (result?.summary?.error) {
        await EbaySyncRun.releaseLock(run, "failed", {
          ...result.summary,
          error: result.summary.error,
        });

        console.error(
          "[EBAY_CATALOG_SYNC_JOB] Run failed:",
          result.summary.error
        );
      } else {
        await EbaySyncRun.releaseLock(run, "completed", {
          ...result.summary,
          error: null,
        });

        console.log("[EBAY_CATALOG_SYNC_JOB] Completed successfully");
      }
    } catch (err) {
      console.error("[EBAY_CATALOG_SYNC_JOB] Run failed:", err.message);

      try {
        await EbaySyncRun.releaseLock(run, "failed", {
          totalDiscovered: 0,
          totalFailed: 0,
          error: err.message,
        });
      } catch (releaseErr) {
        console.error("[EBAY_CATALOG_SYNC_JOB] Failed to release lock:", releaseErr.message);
      }
    }
  });

  console.log("[EBAY_CATALOG_SYNC_JOB] 6-hour sync job registered successfully");
}

module.exports = startEbayCatalogSyncJob;