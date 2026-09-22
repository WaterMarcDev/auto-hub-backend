/**
 * eBay Catalog Sync Job
 *
 * Runs the full CRM → eBay catalog synchronization every 6 hours
 * via node-cron. Uses the EbaySyncRun MongoDB LEASE lock (see
 * models/EbaySyncRun.model.js) to prevent overlapping runs. A single run's
 * failure is caught, logged, released, and never prevents the next scheduled
 * invocation.
 *
 * This is a BACKEND job — it runs from the server process, independent
 * of any frontend page being open or any manual button click.
 *
 * Schedule: runs at minute 0 of every 6th hour (see the cron.schedule
 * call below for the literal expression — not repeated here as a literal
 * cron string because "*" immediately followed by "/" inside a block
 * comment closes the comment early and breaks the whole file).
 *
 * REGISTRATION: guarded by a module-level flag so the SAME process can never
 * register this schedule twice. Cross-process overlap (two Passenger instances
 * during a phased restart) is tolerated and serialized by the MongoDB lease —
 * not by node-cron.
 */
const cron = require("node-cron");
const { syncCatalog } = require("../services/ebay/ebayCatalogSync.service");
const EbaySyncRun = require("../models/EbaySyncRun.model");

const LOG_PREFIX = "[EBAY_CATALOG_SYNC_JOB]";

// Module-level guard: at most one task per process.
let registered = false;
let scheduledTask = null;

/**
 * Start the 6-hour eBay catalog sync cron job.
 * Called from server.js during startup — failure-tolerant.
 */
function startEbayCatalogSyncJob() {
  if (registered) {
    console.log(`${LOG_PREFIX} Already registered in this process — skipping duplicate registration`);
    return;
  }
  registered = true;

  console.log(`${LOG_PREFIX} Scheduling every-6-hour sync...`);

  scheduledTask = cron.schedule("0 */6 * * *", async () => {
    console.log(`${LOG_PREFIX} Triggered (6-hour schedule)`);

    // Centralized acquire → heartbeat → run → ownership-verified release.
    // The lease (not this try/catch) is what recovers a dead owner's lock.
    let outcome;
    try {
      outcome = await EbaySyncRun.withEbaySyncLock("scheduled", async () => {
        return syncCatalog({ dryRun: false, trigger: "scheduled" });
      });
    } catch (err) {
      // withEbaySyncLock re-throws the protected operation's error after
      // safely releasing; log here like the previous catch-did.
      console.error(`${LOG_PREFIX} Run failed:`, (err && err.message) || err);
      return;
    }

    if (!outcome.acquired) {
      if (outcome.code === "SYNC_ALREADY_RUNNING") {
        console.log(`${LOG_PREFIX} Skipping — another sync is already running`);
      } else {
        console.error(`${LOG_PREFIX} Could not acquire lock:`, outcome.code, (outcome.error && outcome.error.message) || "");
      }
      return;
    }

    if (outcome.code === "LOCK_LOST") {
      console.error(`${LOG_PREFIX} Lease lost during run — result discarded, lock NOT released (another owner holds it)`);
      return;
    }

    const summaryError = outcome.result && outcome.result.summary && outcome.result.summary.error;
    if (summaryError) {
      console.error(`${LOG_PREFIX} Run failed:`, summaryError);
    } else {
      console.log(`${LOG_PREFIX} Completed successfully`);
    }
  });

  console.log(`${LOG_PREFIX} 6-hour sync job registered successfully`);
}

/** Stop the scheduled task (used by graceful shutdown). */
startEbayCatalogSyncJob.stop = function stopEbayCatalogSyncJob() {
  if (scheduledTask) {
    try { scheduledTask.stop(); } catch (_) { /* best-effort */ }
  }
  registered = false;
  scheduledTask = null;
};

module.exports = startEbayCatalogSyncJob;
