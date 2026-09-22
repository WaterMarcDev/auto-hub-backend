/**
 * One-off operational recovery for the eBay SYNC lock.
 *
 * PURPOSE: unblock eBay syncing when a lock is genuinely stuck (e.g. the owner
 * process died/was restarted before releasing). This is an OPERATIONAL tool —
 * it is NOT the primary recovery mechanism. The primary mechanism is the lease
 * in models/EbaySyncRun.model.js, which expires by itself.
 *
 * SAFETY:
 *   - Dry-run by default. Nothing is written unless --apply is passed.
 *   - Only clears a lock that is GENUINELY expired/stale (lease expired, or a
 *     legacy doc with no lease that is older than the migration fallback). It
 *     never blindly sets isLocked=false on a healthy active lock.
 *   - The clearing update is itself atomic and re-checks expiry conditions in
 *     the query filter, so a lock that became healthy/owned between the read
 *     and the write is NOT cleared.
 *
 * USAGE (run from the backend directory on the server):
 *   node scripts/recoverStaleEbaySyncLock.js            # dry run (report only)
 *   node scripts/recoverStaleEbaySyncLock.js --apply    # actually recover
 *
 * Never logs credentials. Connects with the same MONGODB_URI the app uses.
 */
require("dotenv").config();

const mongoose = require("mongoose");
const EbaySyncRun = require("../models/EbaySyncRun.model");

const APPLY = process.argv.includes("--apply");
const LOG_PREFIX = "[EBAY_SYNC_LOCK_RECOVERY]";

function legacyCutoff() {
  const cfg = EbaySyncRun.getLockConfig();
  return new Date(Date.now() - cfg.legacyStaleMs);
}

/**
 * A lock is genuinely recoverable when:
 *   - it is lease-aware and leaseExpiresAt < now, OR
 *   - it is legacy (no leaseExpiresAt) and older than the fallback threshold.
 */
function classify(doc) {
  const now = new Date();
  if (doc.leaseExpiresAt) {
    return {
      recoverable: new Date(doc.leaseExpiresAt).getTime() < now.getTime(),
      reason: "lease-aware (leaseExpiresAt=" + new Date(doc.leaseExpiresAt).toISOString() + ")",
    };
  }
  const cutoff = legacyCutoff();
  if (!doc.lockedAt) {
    return { recoverable: true, reason: "legacy with no lockedAt" };
  }
  const age = now.getTime() - new Date(doc.lockedAt).getTime();
  return {
    recoverable: new Date(doc.lockedAt).getTime() < cutoff.getTime(),
    reason: "legacy (lockedAt=" + new Date(doc.lockedAt).toISOString() + ", ageMs=" + age + ")",
  };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error(LOG_PREFIX + " No MONGODB_URI / MONGO_URI configured. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(LOG_PREFIX + " Connected to database: " + mongoose.connection.db.databaseName);
  console.log(LOG_PREFIX + " Mode: " + (APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"));

  const cfg = EbaySyncRun.getLockConfig();
  console.log(
    LOG_PREFIX +
      " Lease config: leaseMs=" + cfg.leaseMs +
      " heartbeatMs=" + cfg.heartbeatMs +
      " legacyStaleMs=" + cfg.legacyStaleMs
  );

  const active = await EbaySyncRun.find({ isLocked: true }).lean();
  if (active.length === 0) {
    console.log(LOG_PREFIX + " No active lock found. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  if (active.length > 1) {
    console.warn(
      LOG_PREFIX + " WARNING: more than one locked document found (" + active.length + "). " +
        "The unique partial index should prevent this; investigate."
    );
  }

  let recovered = 0;
  for (const doc of active) {
    const info = classify(doc);
    console.log(
      LOG_PREFIX + " Active lock runId=" + doc.runId +
        " trigger=" + doc.trigger +
        " owner=" + (doc.ownerToken ? doc.ownerToken.slice(0, 8) : "none") +
        " status=" + doc.status +
        " -> " + (info.recoverable ? "RECOVERABLE" : "ACTIVE (healthy)") +
        " [" + info.reason + "]"
    );

    if (!info.recoverable) {
      console.log(LOG_PREFIX + " Skipping runId=" + doc.runId + " — it is a healthy active lock; not touching it.");
      continue;
    }

    if (!APPLY) {
      console.log(LOG_PREFIX + " Would recover runId=" + doc.runId + " (dry run — re-run with --apply to write).");
      continue;
    }

    // Atomic + self-guarding: re-verify expiry conditions inside the filter so
    // we can never clear a lock that became healthy/owned since the read.
    const now = new Date();
    const cutoff = legacyCutoff();
    const res = await EbaySyncRun.updateOne(
      {
        _id: doc._id,
        isLocked: true,
        $or: [
          { leaseExpiresAt: { $lt: now } },
          { leaseExpiresAt: null, lockedAt: { $lt: cutoff } },
          { leaseExpiresAt: null, lockedAt: null },
        ],
      },
      {
        $set: {
          isLocked: false,
          status: "cancelled",
          completedAt: now,
          error: "Lock manually recovered by scripts/recoverStaleEbaySyncLock.js (verified expired)",
        },
      }
    );
    const modified = (res && (res.modifiedCount ?? res.nModified)) || 0;
    if (modified) {
      recovered++;
      console.log(LOG_PREFIX + " Recovered runId=" + doc.runId + " (isLocked=false, status=cancelled).");
    } else {
      console.log(LOG_PREFIX + " runId=" + doc.runId + " was not modified (no longer matched expiry conditions — left untouched).");
    }
  }

  if (APPLY) {
    const stillActive = await EbaySyncRun.countDocuments({ isLocked: true });
    console.log(LOG_PREFIX + " Done. Recovered=" + recovered + ". Active locks remaining=" + stillActive + ".");
  } else {
    console.log(LOG_PREFIX + " Dry run complete. No changes written.");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(LOG_PREFIX + " FAILED: " + err.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
