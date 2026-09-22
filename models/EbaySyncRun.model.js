/**
 * eBay Sync Run Model
 *
 * Tracks each eBay catalog synchronization run and provides a MongoDB-backed
 * DISTRIBUTED LEASE LOCK that prevents overlapping full-catalog syncs.
 *
 * WHY A LEASE (and not the old "isLocked + 4h stale sweep"):
 * The previous design stored a durable `isLocked` flag but could only clear it
 * from the same Node process that set it (`releaseLock()`). When Passenger
 * gracefully restarts / SIGTERMs / OOM-kills that process mid-sync, the process
 * dies before release, the flag stays `true` forever, and the only recovery was
 * a 4-hour sweep triggered by the NEXT acquire attempt. This module replaces
 * that with a lease:
 *
 *   - every acquisition writes a unique `ownerToken` + `leaseExpiresAt`;
 *   - the owning process renews `leaseExpiresAt` via `heartbeat()`;
 *   - a lock is reclaimable once `leaseExpiresAt < now`;
 *   - release and heartbeat are OWNERSHIP-VERIFIED by `ownerToken`, so an old
 *     (supposedly dead) process can never renew or release a newer owner's lock.
 *
 * Result: a dead owner's lock becomes automatically recoverable after the
 * (short) lease expires — no SSH, no manual MongoDB surgery — while a healthy
 * long-running sync keeps its lease alive indefinitely via heartbeats.
 *
 * The unique partial index on `{ isLocked: true }` is RETAINED and remains the
 * atomic source of truth for mutual exclusion. `acquireLock()` still relies on
 * it (create-then-catch-E11000), never on a check-then-act sequence.
 */
const mongoose = require("mongoose");
const crypto = require("crypto");
const os = require("os");
const ebayConfig = require("../config/ebayCatalogConfig");

// ─── Lease configuration (single authoritative source: config) ──────────────
const LEASE_MS = ebayConfig.EBAY_SYNC_LEASE_MS;
const HEARTBEAT_MS = ebayConfig.EBAY_SYNC_HEARTBEAT_MS;
/** LEGACY migration fallback only — see recoverStaleLocks(). */
const LEGACY_STALE_MS = ebayConfig.EBAY_SYNC_MAX_RUN_DURATION_MS;

// ─── Process identity (stable for this process boot; contains no secrets) ────
// Used purely for observability/ownership correlation in logs and documents.
const BOOT_ID = crypto.randomUUID();
const PROCESS_INSTANCE_ID = `${os.hostname()}:${process.pid}:${BOOT_ID}`;

/**
 * In-flight lock registry for graceful shutdown. Keys are ownerTokens; values
 * are the minimal identity needed for an ownership-verified release. This is
 * deliberately process-local and is ONLY an optimization for clean shutdown —
 * it is never the source of truth (MongoDB + the lease are).
 */
const activeLocks = new Map();

/**
 * Structured lock error. `code` follows the lock taxonomy so callers can
 * distinguish lock lifecycle failures from eBay API failures:
 *   LOCK_UNAVAILABLE        - could not reach/obtain the lock (DB issue)
 *   LOCK_LOST               - this process no longer owns the lock
 *   LOCK_STALE_RECOVERY     - a stale/expired lock was reclaimed
 *   LOCK_OWNERSHIP_MISMATCH - release/renew attempted by a non-owner
 *   LOCK_DATABASE_ERROR     - MongoDB error during a lock operation
 *   SYNC_ALREADY_RUNNING    - the lock is currently held by someone else
 */
function lockError(code, message, meta) {
  const err = new Error(message);
  err.name = "EbaySyncLockError";
  err.code = code;
  if (meta) err.meta = meta;
  return err;
}

/** Short, non-sensitive owner identifier for logs (never a secret). */
function shortOwner(ownerToken) {
  if (!ownerToken || typeof ownerToken !== "string") return "none";
  return ownerToken.slice(0, 8);
}

/**
 * Single structured log line for every lock lifecycle event. Never logs
 * credentials/tokens — ownerToken is only ever emitted shortened.
 */
function logLock(action, run, extra) {
  const parts = [
    "[EBAY_SYNC_LOCK] " + action,
    "runId=" + ((run && run.runId) || "none"),
    "owner=" + shortOwner(run && run.ownerToken),
    "trigger=" + ((run && run.trigger) || (extra && extra.trigger) || "none"),
    "pid=" + PROCESS_INSTANCE_ID,
    "at=" + new Date().toISOString(),
  ];
  if (extra) {
    if (extra.leaseExpiresAt) parts.push("leaseExpiresAt=" + new Date(extra.leaseExpiresAt).toISOString());
    if (extra.count !== undefined) parts.push("count=" + extra.count);
    if (extra.reason) parts.push("reason=" + extra.reason);
    if (extra.code) parts.push("code=" + extra.code);
  }
  console.log(parts.join(" "));
}

const EbaySyncRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, default: function() { return new mongoose.Types.ObjectId().toString(); } },
    trigger: { type: String, enum: ["scheduled", "manual", "retry", "single-product"], required: true },
    isLocked: { type: Boolean, default: false },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    // ── Lease-lock fields (additive; safe/backward compatible) ──────────────
    ownerToken: { type: String, default: null },
    processInstanceId: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    // ── Run history / summary (unchanged) ───────────────────────────────────
    status: { type: String, enum: ["pending", "running", "completed", "failed", "cancelled"], default: "pending" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    error: { type: String, default: null },
    totalDiscovered: { type: Number, default: 0 },
    totalEligible: { type: Number, default: 0 },
    totalExcluded: { type: Number, default: 0 },
    totalSkipped: { type: Number, default: 0 },
    totalCreated: { type: Number, default: 0 },
    totalUpdated: { type: Number, default: 0 },
    totalUnchanged: { type: Number, default: 0 },
    totalPublished: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 },
    totalValidationErrors: { type: Number, default: 0 },
    totalApiErrors: { type: Number, default: 0 },
    failedSkus: { type: [String], default: [] },
    excludedSkus: { type: [String], default: [] },
  },
  { timestamps: true }
);

EbaySyncRunSchema.index({ status: 1, isLocked: 1 });
EbaySyncRunSchema.index({ createdAt: -1 });
// Supports the lease-expiry sweep (recoverStaleLocks) with an index.
EbaySyncRunSchema.index({ isLocked: 1, leaseExpiresAt: 1 });
// Enforces the lock atomically AT THE DATABASE LEVEL: at most one document
// in this collection may have isLocked:true at any moment. This is the
// authority that makes acquireLock() concurrency-safe — its create() is the
// atomic act, and a concurrent winner surfaces as E11000 (handled as normal
// contention, never as a failure). History documents (isLocked:false) are
// exempt via the partial filter, so run history accumulates freely.
EbaySyncRunSchema.index({ isLocked: 1 }, { unique: true, partialFilterExpression: { isLocked: true } });

// ─── Statics (Lock Management) ────────────────────────────────────────────

/**
 * Build the Mongo filter selecting lock documents that are genuinely
 * reclaimable:
 *   - lease-aware docs whose lease has expired, OR
 *   - legacy docs (no leaseExpiresAt) older than the migration fallback.
 * `{ leaseExpiresAt: null }` matches both null and missing fields.
 */
function expiredLockFilter(now) {
  const legacyCutoff = new Date(now.getTime() - LEGACY_STALE_MS);
  return {
    isLocked: true,
    $or: [
      { leaseExpiresAt: { $lt: now } },
      { leaseExpiresAt: null, lockedAt: { $lt: legacyCutoff } },
      { leaseExpiresAt: null, lockedAt: null },
    ],
  };
}

/**
 * Reclaim every genuinely expired/stale lock. Safe to call from any process at
 * any time — it only touches docs that are actually expired. Returns the number
 * of recovered locks. A DB error is surfaced as LOCK_DATABASE_ERROR.
 */
EbaySyncRunSchema.statics.recoverStaleLocks = async function(now) {
  const at = now instanceof Date ? now : new Date();
  let res;
  try {
    res = await this.updateMany(expiredLockFilter(at), {
      $set: {
        isLocked: false,
        status: "cancelled",
        completedAt: at,
        error: "Lock auto-released (lease expired / stale owner)",
      },
    });
  } catch (err) {
    throw lockError("LOCK_DATABASE_ERROR", "Stale-lock recovery failed: " + err.message, { cause: err.message });
  }
  const count = (res && (res.modifiedCount ?? res.nModified)) || 0;
  if (count > 0) {
    logLock("STALE_RECOVERY", null, { count, reason: "lease expired or legacy stale" });
  }
  return count;
};

/**
 * Atomically acquire the sync lease lock. Reclaims expired locks first, then
 * atomically creates a new locked run (the unique partial index is the real
 * mutual-exclusion guarantee).
 *
 * @param {string} trigger - "scheduled" | "manual" | "retry" | "single-product"
 * @returns {Promise<Object|null>} Run doc if acquired; null if held by another.
 * @throws {EbaySyncLockError} LOCK_DATABASE_ERROR on unexpected DB failure.
 */
EbaySyncRunSchema.statics.acquireLock = async function(trigger) {
  const now = new Date();

  // Reclaim expired leases first (best-effort ordering aid). Two racers may
  // both do this — safe, because the atomic create() below is what actually
  // decides the winner and the unique index rejects the loser with E11000.
  await this.recoverStaleLocks(now);

  try {
    const run = await this.create({
      trigger: trigger,
      status: "running",
      isLocked: true,
      lockedAt: now,
      startedAt: now,
      ownerToken: crypto.randomUUID(),
      processInstanceId: PROCESS_INSTANCE_ID,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    });
    activeLocks.set(run.ownerToken, { _id: run._id, ownerToken: run.ownerToken, runId: run.runId });
    logLock("ACQUIRE", run, { trigger, leaseExpiresAt: run.leaseExpiresAt });
    return run;
  } catch (err) {
    if (err && err.code === 11000) {
      // Expected contention. Best-effort: identify the holder for observability.
      let holder = null;
      try {
        holder = await this.findOne({ isLocked: true }).select("runId trigger ownerToken leaseExpiresAt").lean();
      } catch (_) { /* observability only — never fail the acquire on this */ }
      logLock("SYNC_ALREADY_RUNNING", holder, { trigger, code: "SYNC_ALREADY_RUNNING" });
      return null;
    }
    throw lockError("LOCK_DATABASE_ERROR", "acquireLock failed: " + ((err && err.message) || err), { cause: err && err.message });
  }
};

/**
 * Renew the lease for the current owner. Ownership-verified: only updates the
 * document if this exact ownerToken still holds the lock. Returns
 * `{ ok, code }` — `ok:false, code:"LOCK_LOST"` means this process no longer
 * owns the lock (it was reclaimed by someone else) and must stop safe work.
 *
 * A transient DB error throws LOCK_DATABASE_ERROR and does NOT itself declare
 * the lease lost (the lease remains valid for LEASE_MS, so a short Mongo blip
 * is survivable as long as a later heartbeat succeeds before expiry).
 */
EbaySyncRunSchema.statics.heartbeat = async function(run) {
  if (!run || !run._id || !run.ownerToken) {
    return { ok: false, code: "LOCK_LOST" };
  }
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  let res;
  try {
    res = await this.updateOne(
      { _id: run._id, ownerToken: run.ownerToken, isLocked: true },
      { $set: { heartbeatAt: now, leaseExpiresAt } }
    );
  } catch (err) {
    throw lockError("LOCK_DATABASE_ERROR", "heartbeat failed: " + err.message, { cause: err.message });
  }
  const matched = (res && (res.matchedCount ?? res.n)) || 0;
  if (!matched) {
    logLock("LEASE_LOST", run, { code: "LOCK_LOST" });
    return { ok: false, code: "LOCK_LOST" };
  }
  logLock("HEARTBEAT", run, { leaseExpiresAt });
  return { ok: true, code: null };
};

/**
 * Release the lease lock and persist summary counts.
 *
 * OWNERSHIP-VERIFIED: when the run carries an ownerToken the update only
 * matches if that token still owns the lock, so a late/old process can never
 * release (or overwrite summary on) a newer owner's lock. For backward
 * compatibility with any legacy caller passing a run without an ownerToken,
 * the filter falls back to `{ _id, isLocked:true }` (previous behaviour).
 *
 * @returns {Promise<{released:boolean, code:string|null}>}
 * @throws {EbaySyncLockError} LOCK_DATABASE_ERROR on unexpected DB failure.
 */
EbaySyncRunSchema.statics.releaseLock = async function(run, status, summary) {
  if (!status) status = "completed";
  if (!summary) summary = {};
  const updates = {
    isLocked: false,
    status: status,
    completedAt: new Date(),
    durationMs: run && run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
  };
  const countFields = [
    "totalDiscovered", "totalEligible", "totalExcluded", "totalSkipped",
    "totalCreated", "totalUpdated", "totalUnchanged", "totalPublished",
    "totalFailed", "totalValidationErrors", "totalApiErrors",
  ];
  for (let i = 0; i < countFields.length; i++) {
    const f = countFields[i];
    if (summary[f] !== undefined) updates[f] = summary[f];
  }
  if (summary.failedSkus) updates.failedSkus = summary.failedSkus;
  if (summary.excludedSkus) updates.excludedSkus = summary.excludedSkus;
  if (summary.error !== undefined) updates.error = summary.error;

  const filter = { _id: run._id, isLocked: true };
  if (run.ownerToken) filter.ownerToken = run.ownerToken;

  let res;
  try {
    res = await this.updateOne(filter, { $set: updates });
  } catch (err) {
    throw lockError("LOCK_DATABASE_ERROR", "releaseLock failed: " + err.message, { cause: err.message });
  }
  const matched = (res && (res.matchedCount ?? res.n)) || 0;
  if (run.ownerToken) activeLocks.delete(run.ownerToken);
  if (!matched) {
    logLock("OWNERSHIP_MISMATCH", run, { code: "LOCK_OWNERSHIP_MISMATCH", reason: "not the current owner (or lock already released)" });
    return { released: false, code: "LOCK_OWNERSHIP_MISMATCH" };
  }
  logLock("RELEASE", run, { code: status });
  return { released: true, code: null };
};

/**
 * Centralized lock lifecycle: acquire → heartbeat → run protected fn →
 * ownership-verified release. Lock-lifecycle logic lives here ONLY, so jobs and
 * controllers cannot drift apart.
 *
 * `fn(run, state)` receives the run doc and a mutable `state` whose
 * `leaseLost` flag is set true the moment a heartbeat detects lost ownership.
 *
 * `opts.mapOutcome(result)` -> `{ status, summary }` lets a caller preserve its
 * exact existing summary/status mapping. Default derives failed/completed from
 * `result.summary.error`.
 *
 * `opts.onLeaseLost(run, code)` is an optional observability hook.
 *
 * Returns `{ acquired, released, code, result, error }`. Lock contention
 * returns `{ acquired:false, code:"SYNC_ALREADY_RUNNING" }` — callers map that
 * to their existing behaviour. A genuine protected-operation error is
 * re-thrown after the lock is safely released, to preserve existing semantics.
 *
 * NOTE: `finally`/release here only handles a HEALTHY process exiting normally.
 * Process death is handled by lease expiry — never by this cleanup.
 */
EbaySyncRunSchema.statics.withEbaySyncLock = async function(trigger, fn, opts) {
  const options = opts || {};
  let run;
  try {
    run = await this.acquireLock(trigger);
  } catch (err) {
    const code = (err && err.code) || "LOCK_DATABASE_ERROR";
    logLock(code === "SYNC_ALREADY_RUNNING" ? "SYNC_ALREADY_RUNNING" : "LOCK_DATABASE_ERROR", null, { trigger: trigger, code: code, reason: (err && err.message) });
    return { acquired: false, released: false, code: code, result: null, error: err };
  }
  if (!run) {
    return { acquired: false, released: false, code: "SYNC_ALREADY_RUNNING", result: null, error: null };
  }

  const state = { leaseLost: false, code: null };
  let heartbeatTimer = null;
  const stopHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  heartbeatTimer = setInterval(async () => {
    if (state.leaseLost) { stopHeartbeat(); return; }
    try {
      const hb = await this.heartbeat(run);
      if (!hb.ok) {
        state.leaseLost = true;
        state.code = hb.code;
        stopHeartbeat();
        if (typeof options.onLeaseLost === "function") {
          try { options.onLeaseLost(run, hb.code); } catch (_) { /* observability only */ }
        }
      }
    } catch (err) {
      // Transient DB error: do NOT declare lost — the current lease is still
      // valid for up to LEASE_MS. A later successful heartbeat covers the blip.
      console.error("[EBAY_SYNC_LOCK] LOCK_DATABASE_ERROR (heartbeat) runId=" + run.runId + " " + ((err && err.message) || err));
    }
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  const defaultMapOutcome = (result) => {
    const s = (result && result.summary) ? result.summary : {};
    return { status: s.error ? "failed" : "completed", summary: { ...s, error: s.error ?? null } };
  };
  const mapOutcome = typeof options.mapOutcome === "function" ? options.mapOutcome : defaultMapOutcome;

  try {
    const result = await fn(run, state);
    stopHeartbeat();

    if (state.leaseLost) {
      // Ownership gone: never attempt a release (it would be a mismatch) and
      // never report success for work done under a lease we no longer held.
      logLock("LEASE_LOST", run, { code: "LOCK_LOST", reason: "protected operation finished after lease loss" });
      return { acquired: true, released: false, code: "LOCK_LOST", result: result ?? null, error: null };
    }

    const outcome = mapOutcome(result) || {};
    let rel = { released: false, code: null };
    try {
      rel = await this.releaseLock(run, outcome.status || "completed", outcome.summary || {});
    } catch (relErr) {
      console.error("[EBAY_SYNC_LOCK] LOCK_DATABASE_ERROR (release) runId=" + run.runId + " " + ((relErr && relErr.message) || relErr));
    }
    return { acquired: true, released: rel.released, code: rel.code, result: result ?? null, error: null };
  } catch (err) {
    stopHeartbeat();

    if (state.leaseLost) {
      logLock("LEASE_LOST", run, { code: "LOCK_LOST", reason: "protected operation threw after lease loss" });
      return { acquired: true, released: false, code: "LOCK_LOST", result: null, error: err };
    }

    let errorOutcome = { status: "failed", summary: { error: (err && err.message) || String(err) } };
    if (typeof options.mapError === "function") {
      try {
        const mapped = options.mapError(err);
        if (mapped && mapped.status) errorOutcome = mapped;
      } catch (_) { /* fall back to default mapping */ }
    }
    try {
      await this.releaseLock(run, errorOutcome.status || "failed", errorOutcome.summary || {});
    } catch (relErr) {
      console.error("[EBAY_SYNC_LOCK] LOCK_DATABASE_ERROR (release-on-error) runId=" + run.runId + " " + ((relErr && relErr.message) || relErr));
    }
    throw err; // preserve existing error propagation to callers
  }
};

/**
 * Graceful-shutdown helper: attempt ownership-verified release of every lock
 * this process currently holds, bounded by a short timeout so Passenger
 * shutdown is never blocked indefinitely. This is a SECONDARY safety layer —
 * if it fails, the lease still expires and the lock becomes reclaimable.
 */
EbaySyncRunSchema.statics.shutdownActiveLocks = async function(timeoutMs) {
  const timeout = timeoutMs || 3000;
  const entries = Array.from(activeLocks.values());
  if (entries.length === 0) return { total: 0, released: 0, timedOut: false };

  const work = entries.map((e) =>
    this.releaseLock({ _id: e._id, ownerToken: e.ownerToken }, "cancelled", { error: "Lock released during graceful shutdown" })
      .then((r) => r && r.released)
      .catch((err) => {
        console.error("[EBAY_SYNC_LOCK] LOCK_DATABASE_ERROR (shutdown release) runId=" + e.runId + " " + ((err && err.message) || err));
        return false;
      })
  );

  // Single shared promise so a timeout can return WITHOUT the caller awaiting a
  // second time (which would block shutdown past the bound we just promised).
  const allWork = Promise.allSettled(work);
  let timedOut = false;
  await Promise.race([
    allWork,
    new Promise((resolve) => { const t = setTimeout(() => { timedOut = true; resolve(); }, timeout); if (t.unref) t.unref(); }),
  ]);

  activeLocks.clear();
  let released = 0;
  if (!timedOut) {
    const results = await allWork;
    released = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  }
  return { total: entries.length, released, timedOut };
};

/** Get the most recent EbaySyncRun document. */
EbaySyncRunSchema.statics.getLatestRun = function() {
  return this.findOne().sort({ createdAt: -1 }).lean();
};

/** Lease configuration + process identity (for diagnostics/tests). */
EbaySyncRunSchema.statics.getLockConfig = function() {
  return { leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS, legacyStaleMs: LEGACY_STALE_MS, processInstanceId: PROCESS_INSTANCE_ID };
};

module.exports = mongoose.model("EbaySyncRun", EbaySyncRunSchema);
