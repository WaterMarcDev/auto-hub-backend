/**
 * Inventory sync worker (every minute, INVENTORY_SYNC_WORKER_SCHEDULE).
 *
 *   1. eBay webhook events due for processing/retry  (ebayNotification.service)
 *   2. CRM → eBay quantity pushes due/retry          (ebayQuantitySync.service)
 *   3. Reconciliation report, once an hour            (inventoryReconciliation.service)
 *
 * Both queues also run moments after new work arrives; this schedule is the
 * retry/backoff driver and the safety net. Own JobLock lease
 * ("inventory-sync-worker"), so runs never overlap across processes.
 * Disable with DISABLE_INVENTORY_SYNC_WORKER=true.
 */
const os = require("os");
const crypto = require("crypto");
const cron = require("node-cron");
const mongoose = require("mongoose");
const JobLock = require("../models/JobLock.model");
const { processEvents } = require("../services/ebayNotification.service");
const { processQueue } = require("../services/ebayQuantitySync.service");
const { runReconciliation, getLatestReport } = require("../services/inventoryReconciliation.service");

const LOG_PREFIX = "[INVENTORY_SYNC_WORKER]";
const LOCK_NAME = "inventory-sync-worker";
const LEASE_MS = 5 * 60 * 1000;
const DEFAULT_SCHEDULE = "* * * * *";
const RECONCILE_EVERY_MS = 60 * 60 * 1000;

let registered = false;
let scheduledTask = null;
let stopping = false;
const owner = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

async function runOnce({ forceReconcile = false } = {}) {
  if (stopping || mongoose.connection.readyState !== 1) return { ran: false };
  const acquired = await JobLock.acquire(LOCK_NAME, owner, LEASE_MS);
  if (!acquired) return { ran: false, reason: "already running" };
  const out = { ran: true };
  try {
    out.events = await processEvents().catch((e) => ({ error: e.message }));
    out.ebayQuantity = await processQueue().catch((e) => ({ error: e.message }));

    const last = await getLatestReport().catch(() => null);
    const due = forceReconcile || !last?.runAt || Date.now() - new Date(last.runAt).getTime() >= RECONCILE_EVERY_MS;
    if (due) {
      const r = await runReconciliation().catch((e) => ({ error: e.message }));
      out.reconciliation = r.error ? r : { totalIssues: r.totalIssues, counts: r.counts };
    }

    const busy =
      out.events?.processed || out.ebayQuantity?.processed || out.reconciliation?.totalIssues || out.events?.error || out.ebayQuantity?.error;
    if (busy) console.log(`${LOG_PREFIX}`, JSON.stringify(out));
    return out;
  } finally {
    await JobLock.release(LOCK_NAME, owner).catch(() => {});
  }
}

function startInventorySyncWorkerJob() {
  if (process.env.DISABLE_INVENTORY_SYNC_WORKER === "true") {
    console.log(`${LOG_PREFIX} Disabled by DISABLE_INVENTORY_SYNC_WORKER`);
    return;
  }
  if (registered) return;
  const schedule = process.env.INVENTORY_SYNC_WORKER_SCHEDULE || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`${LOG_PREFIX} Invalid INVENTORY_SYNC_WORKER_SCHEDULE "${schedule}" — job not started`);
    return;
  }
  registered = true;
  scheduledTask = cron.schedule(schedule, () => {
    runOnce().catch((err) => console.error(`${LOG_PREFIX} run failed:`, (err && err.message) || err));
  });
  console.log(`${LOG_PREFIX} Scheduled (${schedule})`);
}

function stopInventorySyncWorkerJob() {
  stopping = true;
  if (scheduledTask) {
    try {
      scheduledTask.stop();
    } catch (_) {
      /* best-effort */
    }
  }
}

startInventorySyncWorkerJob.stop = stopInventorySyncWorkerJob;
startInventorySyncWorkerJob.runOnce = runOnce;

module.exports = startInventorySyncWorkerJob;
