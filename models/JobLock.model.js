/**
 * JobLock — tiny cross-process lease lock for lightweight background jobs.
 *
 * Why not EbaySyncRun.withEbaySyncLock? That lock is a single global lock
 * shared by the CRM → eBay catalog push (which can hold it for hours) and
 * the listing reconcile, and every acquisition writes an EbaySyncRun history
 * document. A job that runs every few minutes must neither wait hours behind
 * the catalog push nor flood that history, so it gets its own named lease.
 *
 * Semantics: one document per lock name. A lock is free when it doesn't
 * exist or its lease has expired, so a crashed/killed process can never hold
 * a lock forever — the lease simply runs out.
 */
const mongoose = require("mongoose");

const JobLockSchema = new mongoose.Schema(
  {
    _id: { type: String }, // lock name
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: true }
);

/**
 * Try to take (or renew, if we already own it) the named lease.
 * @returns {Promise<boolean>} true when this owner now holds the lock
 */
JobLockSchema.statics.acquire = async function (name, owner, leaseMs) {
  const now = new Date();
  try {
    const doc = await this.findOneAndUpdate(
      { _id: name, $or: [{ expiresAt: { $lte: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs) } },
      { upsert: true, new: true }
    ).lean();
    return Boolean(doc && doc.owner === owner);
  } catch (err) {
    // E11000: the lock document exists and is held (unexpired) by another
    // owner, so the filter didn't match and the upsert collided on _id.
    if (err && err.code === 11000) return false;
    throw err;
  }
};

/** Release the lease, but only if this owner still holds it. */
JobLockSchema.statics.release = async function (name, owner) {
  await this.deleteOne({ _id: name, owner });
};

module.exports = mongoose.model("JobLock", JobLockSchema);
