/**
 * Master switch for every background CRON and SYNC job.
 *
 *   DISABLE_ALL_CRON_SYNC=true   → no scheduled job starts and the eBay
 *                                  background auto-runs stay idle, whatever
 *                                  the individual job variables say
 *                                  (DISABLE_VIN_CRON, EBAY_CATALOG_CRON_ENABLED,
 *                                  DISABLE_EBAY_MESSAGE_SYNC, ...).
 *   DISABLE_ALL_CRON_SYNC=false  → (or not set) jobs run as before, each one
 *                                  still following its own variable.
 *
 * Only the exact value "true" (any letter case, surrounding spaces ignored)
 * switches jobs off, so a typo can never stop them by accident.
 * Read on every call, not cached. Changing it still needs a server restart,
 * because scheduled jobs are only started once, at startup.
 */
function isAllCronSyncDisabled() {
  return String(process.env.DISABLE_ALL_CRON_SYNC || "").trim().toLowerCase() === "true";
}

module.exports = { isAllCronSyncDisabled };
