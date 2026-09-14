/**
 * eBay Sync Run Model
 *
 * Tracks each eBay catalog synchronization run and provides a
 * MongoDB-backed mutual-exclusion lock that prevents overlapping
 * full-catalog syncs. Stale locks are auto-released.
 */
const mongoose = require("mongoose");

const EbaySyncRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, default: function() { return new mongoose.Types.ObjectId().toString(); } },
    trigger: { type: String, enum: ["scheduled", "manual", "retry", "single-product"], required: true },
    isLocked: { type: Boolean, default: false },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
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
// Enforces the lock atomically AT THE DATABASE LEVEL: at most one document
// in this collection may have isLocked:true at any moment. Without this,
// acquireLock()'s findOne-then-create is a check-then-act race — two
// overlapping calls (e.g. a manual "Sync Now" click landing at the exact
// moment the 6-hour cron fires) can both complete their findOne() before
// either finishes create(), both see "no lock held", and both proceed,
// defeating the lock entirely. This is a real risk even in a single Node
// process, since the race window is an async Mongo round-trip, not
// multiple threads/processes. The partial filter means unlocked (released)
// run-history documents are entirely exempt, so history accumulates freely.
EbaySyncRunSchema.index({ isLocked: 1 }, { unique: true, partialFilterExpression: { isLocked: true } });

// ─── Statics (Lock Management) ────────────────────────────────────────────

var MAX_RUN_DURATION_MS = parseInt(process.env.EBAY_SYNC_MAX_RUN_DURATION_MS || (4 * 60 * 60 * 1000).toString(), 10);

/**
 * Atomically acquire the sync lock. Releases stale locks first.
 * @param {string} trigger - "scheduled", "manual", etc.
 * @returns {Promise<Object|null>} Run doc if lock acquired, null if held.
 */
EbaySyncRunSchema.statics.acquireLock = async function(trigger) {
  var staleThreshold = new Date(Date.now() - MAX_RUN_DURATION_MS);
  await this.updateMany(
    { isLocked: true, lockedAt: { $lt: staleThreshold } },
    { $set: { isLocked: false, status: "cancelled", completedAt: new Date(), error: "Lock auto-released (stale/crashed)" } }
  );

  var existingLock = await this.findOne({ isLocked: true }).sort({ lockedAt: -1 }).lean();
  if (existingLock) {
    console.log("[EBAY_SYNC_LOCK] Held by run " + existingLock.runId + " (trigger=" + existingLock.trigger + ")");
    return null;
  }

  // The findOne() check above is advisory only (fast path / better error
  // message) — it is NOT what actually prevents two overlapping runs. The
  // partial unique index on { isLocked: true } (see schema definition
  // above) is what makes this atomic: if another caller's create() commits
  // between our findOne() and this create(), Mongo rejects this insert
  // with E11000 and we correctly report the lock as held instead of both
  // callers proceeding.
  try {
    var run = await this.create({
      trigger: trigger, status: "running", isLocked: true, lockedAt: new Date(), startedAt: new Date(),
    });
    console.log("[EBAY_SYNC_LOCK] Acquired run " + run.runId + " (trigger=" + trigger + ")");
    return run;
  } catch (err) {
    if (err && err.code === 11000) {
      console.log("[EBAY_SYNC_LOCK] Lost race to acquire lock (concurrent caller won) — skipping");
      return null;
    }
    throw err;
  }
};

/**
 * Release the lock and persist summary counts.
 */
EbaySyncRunSchema.statics.releaseLock = async function(run, status, summary) {
  if (!status) status = "completed";
  if (!summary) summary = {};
  var updates = {
    isLocked: false, status: status,
    completedAt: new Date(),
    durationMs: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
  };
  var countFields = [
    "totalDiscovered", "totalEligible", "totalExcluded", "totalSkipped",
    "totalCreated", "totalUpdated", "totalUnchanged", "totalPublished",
    "totalFailed", "totalValidationErrors", "totalApiErrors",
  ];
  for (var i = 0; i < countFields.length; i++) {
    var f = countFields[i];
    if (summary[f] !== undefined) updates[f] = summary[f];
  }
  if (summary.failedSkus) updates.failedSkus = summary.failedSkus;
  if (summary.excludedSkus) updates.excludedSkus = summary.excludedSkus;
  if (summary.error) updates.error = summary.error;

  await this.findByIdAndUpdate(run._id, { $set: updates });
  console.log("[EBAY_SYNC_LOCK] Released run " + run.runId + " (status=" + status + ")");
};

/** Get the most recent EbaySyncRun document. */
EbaySyncRunSchema.statics.getLatestRun = function() {
  return this.findOne().sort({ createdAt: -1 }).lean();
};

module.exports = mongoose.model("EbaySyncRun", EbaySyncRunSchema);