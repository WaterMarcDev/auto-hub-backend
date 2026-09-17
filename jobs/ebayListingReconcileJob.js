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
 * LOCKING: reuses the existing EbaySyncRun Mongo-backed mutual-exclusion lock
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
 */
const cron = require("node-cron");
const {
  reconcileEbayListings,
} = require("../services/ebay/ebayListingReconcile.service");
const EbaySyncRun = require("../models/EbaySyncRun.model");

const LOG_PREFIX = "[EBAY_LISTING_RECONCILE_JOB]";

/**
 * Start the scheduled eBay → CRM listing reconciliation.
 * Called from server.js during startup — failure-tolerant.
 */
function startEbayListingReconcileJob() {
  console.log(`${LOG_PREFIX} Scheduling eBay → CRM active listing reconciliation (every 30 minutes)...`);

  cron.schedule("*/30 * * * *", async () => {
    console.log(`${LOG_PREFIX} Triggered (30-minute schedule)`);

    let run = null;
    try {
      // Reuse the existing distributed lock — never a competing mechanism.
      run = await EbaySyncRun.acquireLock("scheduled");
      if (!run) {
        console.log(`${LOG_PREFIX} Skipping — another eBay sync run holds the lock`);
        return;
      }

      const summary = await reconcileEbayListings();

      await EbaySyncRun.releaseLock(run, "completed", {
        totalDiscovered: summary.activeOnEbay,
        totalCreated: summary.created,
        totalUpdated: summary.updated,
        totalUnchanged: summary.unchanged,
        totalFailed: summary.fetchComplete ? 0 : 1,
        error: summary.fetchComplete ? null : summary.fetchError,
      });

      console.log(
        `${LOG_PREFIX} Completed: active=${summary.activeOnEbay} created=${summary.created} updated=${summary.updated} removed=${summary.removed} unchanged=${summary.unchanged}`
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Run failed:`, err.message || err);

      if (run) {
        try {
          await EbaySyncRun.releaseLock(run, "failed", {
            totalDiscovered: 0,
            totalFailed: 1,
            error: err.message || String(err),
          });
        } catch (releaseErr) {
          console.error(`${LOG_PREFIX} Failed to release lock:`, releaseErr.message);
        }
      }
    }
  });

  console.log(`${LOG_PREFIX} 30-minute reconciliation job registered successfully`);
}

module.exports = startEbayListingReconcileJob;
