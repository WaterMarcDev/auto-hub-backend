/**
 * Pause switch for eBay syncing.
 *
 *   EBAY_SYNC_PAUSED not set, or anything other than "false"  → PAUSED
 *   EBAY_SYNC_PAUSED=false                                    → normal syncing
 *
 * Paused by default on purpose: the CRM must not write anything to eBay
 * until someone deliberately sets EBAY_SYNC_PAUSED=false and restarts.
 *
 * While paused:
 *   - CRM → eBay catalog push (6-hour cron, "Sync Now", single-product sync,
 *     "Retry") is refused, so nothing is created, revised or published on
 *     eBay. Dry runs are still allowed because they never write to eBay.
 *   - CRM → eBay quantity pushes are not sent. Quantity changes stay queued
 *     on each part and are sent once syncing is resumed.
 *   - The 30-minute eBay → CRM listing reconciliation job does not run.
 *     The manual "Sync eBay Listings" button on Marketplace Listings still
 *     works: it only reads from eBay and is needed to clean up CRM rows.
 *
 * Not affected: eBay order/sales sync, buyer message sync and webhook
 * notifications. They only read from eBay into the CRM.
 *
 * Read on every call. Manual buttons follow a change after a restart with
 * --update-env; scheduled jobs are registered once at startup, so a restart
 * is needed for them as well.
 */
function isEbaySyncPaused() {
  return String(process.env.EBAY_SYNC_PAUSED ?? "").trim().toLowerCase() !== "false";
}

const EBAY_SYNC_PAUSED_CODE = "EBAY_SYNC_PAUSED";
const EBAY_SYNC_PAUSED_MESSAGE =
  "eBay syncing is paused. Nothing is being sent to eBay. Set EBAY_SYNC_PAUSED=false on the server and restart to resume.";

function ebaySyncPausedError() {
  const err = new Error(EBAY_SYNC_PAUSED_MESSAGE);
  err.code = EBAY_SYNC_PAUSED_CODE;
  err.statusCode = 423;
  return err;
}

module.exports = {
  isEbaySyncPaused,
  ebaySyncPausedError,
  EBAY_SYNC_PAUSED_CODE,
  EBAY_SYNC_PAUSED_MESSAGE,
};
