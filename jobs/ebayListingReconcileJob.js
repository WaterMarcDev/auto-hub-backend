/**
 * eBay Active Listing Reconciliation Job (eBay → CRM)
 *
 * Runs the eBay → CRM Marketplace Listing reconciliation automatically on a
 * schedule, so a listing that becomes active, ends, changes price/quantity, or
 * is withdrawn is reflected in the CRM without manual intervention.
 *
 * DIRECTION: this is the eBay → CRM PULL direction. It is completely separate
 * from jobs/ebayCatalogSyncJob.js, which is the CRM → eBay PUSH direction.
 * Neither job modifies the other's behaviour.
 *
 * LOCKING: reuses the existing EbaySyncRun MongoDB LEASE lock
 * (models/EbaySyncRun.model.js) rather than introducing a second locking
 * mechanism. Consequences of sharing it — both intentional and safe:
 *   - Two scheduled reconcile runs can never overlap;
 *   - A reconcile run can never overlap a manual "Sync eBay Listings" click;
 *   - A reconcile run cannot overlap the CRM → eBay catalog push either, so
 *     the two directions never interleave their writes.
 * The lock is acquired with the existing "scheduled" trigger value (the model
 * enum is unchanged), so no schema change is required.
 *
 * FAILURE TOLERANCE: a failed run is caught, logged, released, and never
 * prevents the next scheduled invocation. A failed eBay fetch can never cause
 * removals — that gate lives inside the reconciliation service itself.
 *
 * REGISTRATION: guarded by a module-level flag so the SAME process can never
 * register this schedule twice. Cross-process overlap is serialized by the
 * MongoDB lease, not by node-cron.
 */
const cron = require("node-cron");
const {
  reconcileEbayListings,
} = require("../services/ebay/ebayListingReconcile.service");
const EbaySyncRun = require("../models/EbaySyncRun.model");

const LOG_PREFIX = "[EBAY_LISTING_RECONCILE_JOB]";

let registered = false;
let scheduledTask = null;

/**
 * Start the scheduled eBay → CRM listing reconciliation.
 * Called from server.js during startup — failure-tolerant.
 */
function startEbayListingReconcileJob() {
  if (registered) {
    console.log(`${LOG_PREFIX} Already registered in this process — skipping duplicate registration`);
    return;
  }
  registered = true;

  console.log(`${LOG_PREFIX} Scheduling eBay → CRM active listing reconciliation (every 30 minutes)...`);

  scheduledTask = cron.schedule("*/30 * * * *", async () => {
    console.log(`${LOG_PREFIX} Triggered (30-minute schedule)`);

    let outcome;
    try {
      outcome = await EbaySyncRun.withEbaySyncLock(
        "scheduled",
        async () => reconcileEbayListings(),
        {
          // Preserve the EXACT previous release mapping: status is always
          // "completed" for this job (fetch completeness is recorded in
          // totalFailed/error, never as a "failed" run).
          mapOutcome: (summary) => {
            const s = summary || {};
            return {
              status: "completed",
              summary: {
                totalDiscovered: s.activeOnEbay,
                totalCreated: s.created,
                totalUpdated: s.updated,
                totalUnchanged: s.unchanged,
                totalFailed: s.fetchComplete ? 0 : 1,
                error: s.fetchComplete ? null : s.fetchError,
              },
            };
          },
        }
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Run failed:`, (err && err.message) || err);
      return;
    }

    if (!outcome.acquired) {
      if (outcome.code === "SYNC_ALREADY_RUNNING") {
        console.log(`${LOG_PREFIX} Skipping — another eBay sync run holds the lock`);
      } else {
        console.error(`${LOG_PREFIX} Could not acquire lock:`, outcome.code, (outcome.error && outcome.error.message) || "");
      }
      return;
    }

    if (outcome.code === "LOCK_LOST") {
      console.error(`${LOG_PREFIX} Lease lost during run — result discarded, lock NOT released (another owner holds it)`);
      return;
    }

    const s = outcome.result || {};
    console.log(
      `${LOG_PREFIX} Completed: active=${s.activeOnEbay} created=${s.created} updated=${s.updated} removed=${s.removed} unchanged=${s.unchanged}`
    );
  });

  console.log(`${LOG_PREFIX} 30-minute reconciliation job registered successfully`);
}

/** Stop the scheduled task (used by graceful shutdown). */
startEbayListingReconcileJob.stop = function stopEbayListingReconcileJob() {
  if (scheduledTask) {
    try { scheduledTask.stop(); } catch (_) { /* best-effort */ }
  }
  registered = false;
  scheduledTask = null;
};

module.exports = startEbayListingReconcileJob;
