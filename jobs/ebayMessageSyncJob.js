/**
 * eBay Message Sync Job (eBay → CRM Marketplace Inbox)
 *
 * Runs services/ebay/ebayMessageSync.service.js on a short schedule so eBay
 * buyer messages reach the Marketplace Inbox in near real time. Runs
 * entirely in the backend; the frontend only receives `new_message` socket
 * events.
 *
 * Safety (this runs inside the web process on a small server):
 *   - Never runs at startup; the first run is on the next schedule tick, so a
 *     restarting or crash-looping process does no eBay work.
 *   - Skips quietly while MongoDB isn't connected.
 *   - One run at a time per process (in-memory flag) and across processes
 *     (JobLock lease). The lease expires on its own if a process dies.
 *   - Each run is bounded by page/detail caps and a time budget
 *     (see the service).
 *   - Consecutive failures back off exponentially (skipped ticks), capped at
 *     about an hour, and error logs are throttled.
 *   - Never throws out of the cron callback.
 *
 * Config (all optional):
 *   DISABLE_EBAY_MESSAGE_SYNC=true      turn the job off
 *   EBAY_MESSAGE_SYNC_SCHEDULE          cron expression, default every 5 minutes
 *   EBAY_MESSAGE_SYNC_DEEP_SCAN_EVERY   every Nth run ignores the early page stop (default 6, ≈30 min)
 *   EBAY_MESSAGE_SYNC_MAX_PAGES / _MAX_DETAILS / _TIME_BUDGET_MS   see the service
 */
const os = require("os");
const crypto = require("crypto");
const cron = require("node-cron");
const mongoose = require("mongoose");
const JobLock = require("../models/JobLock.model");
const { syncEbayMessages } = require("../services/ebay/ebayMessageSync.service");

const LOG_PREFIX = "[EBAY_MESSAGE_SYNC_JOB]";
const LOCK_NAME = "ebay-message-sync";
// Longer than the service's time budget plus eBay retry time, so a live run
// never loses its lease; short enough that a dead process frees it quickly.
const LEASE_MS = 5 * 60 * 1000;
// 12 ticks × 5 min ≈ 1 hour maximum wait between attempts while failing.
const MAX_BACKOFF_TICKS = 12;

const DEFAULT_SCHEDULE = "*/5 * * * *";
const DEEP_SCAN_EVERY = Math.max(1, parseInt(process.env.EBAY_MESSAGE_SYNC_DEEP_SCAN_EVERY, 10) || 6);

let registered = false;
let scheduledTask = null;
let running = false;
let stopping = false;
let runCount = 0;
let consecutiveFailures = 0;
let ticksToSkip = 0;

const owner = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

async function runOnce(io) {
  if (running || stopping) return;
  if (ticksToSkip > 0) {
    ticksToSkip -= 1;
    return;
  }
  if (mongoose.connection.readyState !== 1) return;

  running = true;
  let acquired = false;
  try {
    acquired = await JobLock.acquire(LOCK_NAME, owner, LEASE_MS);
    if (!acquired) return; // another process is running it

    runCount += 1;
    const deepScan = runCount % DEEP_SCAN_EVERY === 0;
    const summary = await syncEbayMessages({ io, deepScan });

    if (consecutiveFailures > 0) {
      console.log(`${LOG_PREFIX} Recovered after ${consecutiveFailures} failed run(s)`);
    }
    consecutiveFailures = 0;

    if (summary.newMessages > 0 || summary.conversationErrors > 0 || summary.stoppedEarlyBy) {
      console.log(
        `${LOG_PREFIX} new=${summary.newMessages} fetched=${summary.detailFetches} ` +
          `checked=${summary.conversationsChecked} pages=${summary.pagesScanned} ` +
          `errors=${summary.conversationErrors}${summary.stoppedEarlyBy ? ` stoppedBy=${summary.stoppedEarlyBy}` : ""}` +
          `${deepScan ? " (deep)" : ""}`
      );
    }
  } catch (err) {
    consecutiveFailures += 1;
    ticksToSkip = Math.min(2 ** (consecutiveFailures - 1) - 1, MAX_BACKOFF_TICKS);
    if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
      console.error(
        `${LOG_PREFIX} Run failed (${consecutiveFailures} in a row; skipping next ${ticksToSkip} tick(s)):`,
        (err && err.message) || err
      );
    }
  } finally {
    if (acquired) {
      await JobLock.release(LOCK_NAME, owner).catch(() => {});
    }
    running = false;
  }
}

/**
 * Register the schedule. Called from server.js after the server starts.
 * @param {Object} [options]
 * @param {import("socket.io").Server} [options.io]
 */
function startEbayMessageSyncJob({ io = null } = {}) {
  if (process.env.DISABLE_EBAY_MESSAGE_SYNC === "true") {
    console.log(`${LOG_PREFIX} Disabled by DISABLE_EBAY_MESSAGE_SYNC`);
    return;
  }
  if (registered) return;

  const schedule = process.env.EBAY_MESSAGE_SYNC_SCHEDULE || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`${LOG_PREFIX} Invalid EBAY_MESSAGE_SYNC_SCHEDULE "${schedule}" — job not started`);
    return;
  }

  registered = true;
  scheduledTask = cron.schedule(schedule, () => {
    runOnce(io).catch(() => {});
  });
  console.log(`${LOG_PREFIX} Scheduled (${schedule})`);
}

/** Stop scheduling new runs (graceful shutdown). */
function stopEbayMessageSyncJob() {
  stopping = true;
  if (scheduledTask) {
    try {
      scheduledTask.stop();
    } catch (_) {
      /* best-effort */
    }
  }
}

startEbayMessageSyncJob.stop = stopEbayMessageSyncJob;

module.exports = startEbayMessageSyncJob;
module.exports.stop = stopEbayMessageSyncJob;
module.exports._runOnce = runOnce;
