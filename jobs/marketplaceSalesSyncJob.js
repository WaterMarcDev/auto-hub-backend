/**
 * Marketplace Sales Sync Job (eBay + Wix → CRM sold status)
 *
 * Every 15 minutes (MARKETPLACE_SALES_SYNC_SCHEDULE) reads eBay and Wix
 * orders changed since the last run and marks the matching CRM parts sold —
 * see services/marketplaceSales.service.js. Read-only towards eBay and Wix.
 *
 * LOCKING: its own JobLock lease ("marketplace-sales-sync"), shared with the
 * manual "Sync now" button (runNow), so two runs never overlap. It does NOT
 * use the EbaySyncRun lock, so it never waits behind the catalog push.
 *
 * Disable with DISABLE_MARKETPLACE_SALES_SYNC=true.
 */
const os = require("os");
const crypto = require("crypto");
const cron = require("node-cron");
const mongoose = require("mongoose");
const JobLock = require("../models/JobLock.model");
const { syncAllMarketplaceSales } = require("../services/marketplaceSales.service");

const LOG_PREFIX = "[MARKETPLACE_SALES_SYNC_JOB]";
const LOCK_NAME = "marketplace-sales-sync";
const LEASE_MS = 10 * 60 * 1000;
const DEFAULT_SCHEDULE = "*/15 * * * *";

let registered = false;
let scheduledTask = null;
let stopping = false;
const owner = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

/**
 * Run one eBay + Wix sold-status sync now, unless one is already running.
 * @returns {Promise<{ran: boolean, result?: Object, reason?: string}>}
 */
async function runNow(trigger = "manual") {
  if (mongoose.connection.readyState !== 1) return { ran: false, reason: "Database is not connected" };

  const acquired = await JobLock.acquire(LOCK_NAME, owner, LEASE_MS);
  if (!acquired) return { ran: false, reason: "A sold-status sync is already running" };

  try {
    const result = await syncAllMarketplaceSales();
    const line = (r) =>
      r.error ? `error=${r.error}` : r.skipped ? `skipped=${r.skipped}` : `orders=${r.orders} sold=${r.sold} released=${r.released} conflicts=${r.conflicts} unmatched=${r.unmatched}`;
    console.log(`${LOG_PREFIX} (${trigger}) eBay: ${line(result.ebay)} | Wix: ${line(result.wix)}`);
    return { ran: true, result };
  } finally {
    await JobLock.release(LOCK_NAME, owner).catch(() => {});
  }
}

function startMarketplaceSalesSyncJob() {
  if (process.env.DISABLE_MARKETPLACE_SALES_SYNC === "true") {
    console.log(`${LOG_PREFIX} Disabled by DISABLE_MARKETPLACE_SALES_SYNC`);
    return;
  }
  if (registered) return;

  const schedule = process.env.MARKETPLACE_SALES_SYNC_SCHEDULE || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`${LOG_PREFIX} Invalid MARKETPLACE_SALES_SYNC_SCHEDULE "${schedule}" — job not started`);
    return;
  }

  registered = true;
  scheduledTask = cron.schedule(schedule, () => {
    if (stopping) return;
    runNow("scheduled").catch((err) => console.error(`${LOG_PREFIX} Run failed:`, (err && err.message) || err));
  });
  console.log(`${LOG_PREFIX} Scheduled (${schedule})`);
}

/** Stop scheduling new runs (graceful shutdown). */
function stopMarketplaceSalesSyncJob() {
  stopping = true;
  if (scheduledTask) {
    try {
      scheduledTask.stop();
    } catch (_) {
      /* best-effort */
    }
  }
}

startMarketplaceSalesSyncJob.stop = stopMarketplaceSalesSyncJob;
startMarketplaceSalesSyncJob.runNow = runNow;

module.exports = startMarketplaceSalesSyncJob;
