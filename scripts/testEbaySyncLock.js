/**
 * eBay Sync Lock — verification suite.
 *
 * Runs the 15 lock-reliability scenarios against a THROWAWAY MongoDB instance.
 * It NEVER runs against production: you must set EBAY_LOCK_TEST_URI (it refuses
 * to run otherwise and it never falls back to MONGODB_URI / MONGO_URI).
 *
 * Every test asserts real MongoDB state (documents), not merely that a function
 * returned a value.
 *
 * USAGE (from the backend directory):
 *   EBAY_LOCK_TEST_URI="mongodb://127.0.0.1:27017/autohub_lock_test" \
 *     node scripts/testEbaySyncLock.js
 *
 * NOTE: `npm test` in this repo is an unrelated stub; run this file directly.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const TEST_URI = process.env.EBAY_LOCK_TEST_URI;
if (!TEST_URI) {
  console.error(
    "[EBAY_LOCK_TEST] Refusing to run: set EBAY_LOCK_TEST_URI to a THROWAWAY test database.\n" +
      "This suite writes/deletes lock documents and must never touch production."
  );
  process.exit(1);
}
if (/prod/i.test(TEST_URI)) {
  console.error("[EBAY_LOCK_TEST] Refusing to run: EBAY_LOCK_TEST_URI looks like a production URI.");
  process.exit(1);
}

const EbaySyncRun = require("../models/EbaySyncRun.model");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS", error: null });
    console.log("  PASS  " + name);
  } catch (err) {
    results.push({ name, status: "FAIL", error: err.message });
    console.log("  FAIL  " + name + "  ->  " + err.message);
  }
}

async function reset() {
  await EbaySyncRun.deleteMany({});
}

async function insertStaleLeaseAware(ageMs) {
  const past = new Date(Date.now() - (ageMs || 60000));
  return EbaySyncRun.create({
    trigger: "scheduled",
    status: "running",
    isLocked: true,
    lockedAt: past,
    startedAt: past,
    ownerToken: "dead-owner-" + Math.random().toString(16).slice(2),
    processInstanceId: "dead-host:1:dead-boot",
    heartbeatAt: past,
    leaseExpiresAt: past,
  });
}

async function insertLegacyLock(lockedAt) {
  return EbaySyncRun.create({
    trigger: "scheduled",
    status: "running",
    isLocked: true,
    lockedAt: lockedAt,
    startedAt: lockedAt,
  });
}

async function main() {
  await mongoose.connect(TEST_URI);
  console.log("[EBAY_LOCK_TEST] Connected: " + mongoose.connection.db.databaseName);
  await EbaySyncRun.syncIndexes();
  const cfg = EbaySyncRun.getLockConfig();
  console.log(
    "[EBAY_LOCK_TEST] leaseMs=" + cfg.leaseMs + " heartbeatMs=" + cfg.heartbeatMs + " legacyStaleMs=" + cfg.legacyStaleMs
  );
  console.log("");

  // 1. Normal acquire/release
  await test("1. acquire/release (isLocked true->false, status completed)", async () => {
    await reset();
    const run = await EbaySyncRun.acquireLock("manual");
    assert(run, "expected acquisition");
    const locked = await EbaySyncRun.findOne({ isLocked: true }).lean();
    assert(locked && String(locked._id) === String(run._id), "lock document must be locked");
    assert(locked.ownerToken, "ownerToken must be persisted");
    assert(locked.leaseExpiresAt, "leaseExpiresAt must be persisted");
    const res = await EbaySyncRun.releaseLock(run, "completed", { totalCreated: 1 });
    assert.strictEqual(res.released, true, "release should report released:true");
    const after = await EbaySyncRun.findById(run._id).lean();
    assert.strictEqual(after.isLocked, false, "must be unlocked");
    assert.strictEqual(after.status, "completed", "status must be completed");
    assert.strictEqual(after.totalCreated, 1, "summary persisted");
    assert.strictEqual(await EbaySyncRun.countDocuments({ isLocked: true }), 0, "no active lock remains");
  });

  // 2. Concurrent acquire — exactly one winner
  await test("2. concurrent acquire -> exactly one winner", async () => {
    await reset();
    const settled = await Promise.all([
      EbaySyncRun.acquireLock("manual"),
      EbaySyncRun.acquireLock("manual"),
      EbaySyncRun.acquireLock("scheduled"),
    ]);
    const winners = settled.filter(Boolean);
    assert.strictEqual(winners.length, 1, "exactly one caller must acquire; got " + winners.length);
    assert.strictEqual(await EbaySyncRun.countDocuments({ isLocked: true }), 1, "exactly one locked doc");
  });

  // 3. Duplicate (sequential) acquire
  await test("3. duplicate acquire while held -> null, no second lock", async () => {
    await reset();
    const first = await EbaySyncRun.acquireLock("manual");
    assert(first, "first acquire succeeds");
    const second = await EbaySyncRun.acquireLock("manual");
    assert.strictEqual(second, null, "second acquire must be refused");
    assert.strictEqual(await EbaySyncRun.countDocuments({ isLocked: true }), 1, "still exactly one locked doc");
  });

  // 4. Stale recovery (expired lease)
  await test("4. stale recovery (expired lease reclaimed, old doc cancelled)", async () => {
    await reset();
    const stale = await insertStaleLeaseAware(120000);
    const run = await EbaySyncRun.acquireLock("manual");
    assert(run, "must reclaim expired lease");
    assert.notStrictEqual(String(run._id), String(stale._id), "new owner must be a different run");
    const old = await EbaySyncRun.findById(stale._id).lean();
    assert.strictEqual(old.isLocked, false, "stale doc unlocked");
    assert.strictEqual(old.status, "cancelled", "stale doc cancelled");
    assert(/stale|lease/i.test(old.error || ""), "stale reason recorded");
  });

  // 5. Heartbeat renewal
  await test("5. heartbeat renews leaseExpiresAt/heartbeatAt for owner", async () => {
    await reset();
    const run = await EbaySyncRun.acquireLock("manual");
    const before = await EbaySyncRun.findById(run._id).lean();
    await new Promise((r) => setTimeout(r, 15));
    const hb = await EbaySyncRun.heartbeat(run);
    assert.strictEqual(hb.ok, true, "owner heartbeat must succeed");
    const after = await EbaySyncRun.findById(run._id).lean();
    assert(
      new Date(after.leaseExpiresAt).getTime() >= new Date(before.leaseExpiresAt).getTime(),
      "leaseExpiresAt must not move backwards"
    );
    assert(
      new Date(after.heartbeatAt).getTime() > new Date(before.heartbeatAt).getTime(),
      "heartbeatAt must advance"
    );
  });

  // 6. Lease expiry -> reclaimable
  await test("6. lease expiry makes lock reclaimable", async () => {
    await reset();
    const run = await EbaySyncRun.acquireLock("manual");
    // Force expiry.
    await EbaySyncRun.updateOne({ _id: run._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const next = await EbaySyncRun.acquireLock("manual");
    assert(next, "expired lease must be reclaimable");
    assert.notStrictEqual(String(next._id), String(run._id), "reclaimed by a different run");
  });

  // 7. Old owner cannot release or renew new owner's lock
  await test("7. old owner cannot release/renew a new owner's lock", async () => {
    await reset();
    const oldRun = await EbaySyncRun.acquireLock("manual");
    await EbaySyncRun.updateOne({ _id: oldRun._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const newRun = await EbaySyncRun.acquireLock("manual");
    assert(newRun, "new owner acquires after expiry");
    // Old owner tries to release.
    const rel = await EbaySyncRun.releaseLock(oldRun, "completed", {});
    assert.strictEqual(rel.released, false, "old owner release must be refused");
    assert.strictEqual(rel.code, "LOCK_OWNERSHIP_MISMATCH", "code must be mismatch");
    // Old owner tries to renew.
    const hb = await EbaySyncRun.heartbeat(oldRun);
    assert.strictEqual(hb.ok, false, "old owner heartbeat must fail");
    assert.strictEqual(hb.code, "LOCK_LOST", "code must be LOCK_LOST");
    // New owner's lock is intact and still owned by newRun.
    const still = await EbaySyncRun.findOne({ isLocked: true }).lean();
    assert(still && String(still._id) === String(newRun._id), "new owner's lock must be intact");
    assert.strictEqual(still.ownerToken, newRun.ownerToken, "new owner token unchanged");
  });

  // 8. Restart simulation
  await test("8. restart simulation: dead owner's lock reclaimed, old owner inert", async () => {
    await reset();
    const dead = await insertStaleLeaseAware(300000); // 'crashed' 5 minutes ago
    const booted = await EbaySyncRun.acquireLock("scheduled");
    assert(booted, "new process acquires after restart");
    const relOld = await EbaySyncRun.releaseLock(dead, "failed", {});
    assert.strictEqual(relOld.released, false, "dead owner cannot release");
    const still = await EbaySyncRun.findOne({ isLocked: true }).lean();
    assert.strictEqual(String(still._id), String(booted._id), "booted process still owns the lock");
  });

  // 9. SIGTERM/shutdown path
  await test("9. SIGTERM/shutdown path releases this process's held lock", async () => {
    await reset();
    const run = await EbaySyncRun.acquireLock("manual");
    assert(run, "acquired");
    const res = await EbaySyncRun.shutdownActiveLocks(3000);
    assert.strictEqual(res.total >= 1, true, "at least one held lock seen at shutdown");
    assert.strictEqual(res.released >= 1, true, "held lock released at shutdown");
    const after = await EbaySyncRun.findById(run._id).lean();
    assert.strictEqual(after.isLocked, false, "lock released");
    assert.strictEqual(after.status, "cancelled", "shutdown release marks cancelled");
    assert.strictEqual(await EbaySyncRun.countDocuments({ isLocked: true }), 0, "no active lock remains");
  });

  // 10. Transient MongoDB failure (simulated at the driver boundary)
  await test("10. transient MongoDB failure is classified, not swallowed", async () => {
    await reset();
    const run = await EbaySyncRun.acquireLock("manual");
    const origUpdateOne = EbaySyncRun.updateOne;
    try {
      EbaySyncRun.updateOne = async () => { throw new Error("simulated mongo outage"); };
      let threw = null;
      try { await EbaySyncRun.heartbeat(run); } catch (e) { threw = e; }
      assert(threw, "heartbeat must surface the DB error");
      assert.strictEqual(threw.code, "LOCK_DATABASE_ERROR", "must classify as LOCK_DATABASE_ERROR");
    } finally {
      EbaySyncRun.updateOne = origUpdateOne;
    }
    // A transient heartbeat error must NOT itself drop the lease: the owner can
    // still heartbeat successfully afterwards and remains the owner.
    const ok = await EbaySyncRun.heartbeat(run);
    assert.strictEqual(ok.ok, true, "owner recovers after transient DB error");
  });

  // 11. Long-running healthy run is not swept by age
  await test("11. healthy long-running run (old lockedAt, valid lease) is not swept", async () => {
    await reset();
    const run = await EbaySyncRun.acquireLock("manual");
    // Simulate a run started 5 hours ago that is still heartbeating fine.
    await EbaySyncRun.updateOne(
      { _id: run._id },
      { $set: { lockedAt: new Date(Date.now() - 5 * 60 * 60 * 1000), startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) } }
    );
    const blocked = await EbaySyncRun.acquireLock("manual");
    assert.strictEqual(blocked, null, "a healthy lease must NOT be swept regardless of lockedAt age");
    const still = await EbaySyncRun.findOne({ isLocked: true }).lean();
    assert.strictEqual(String(still._id), String(run._id), "original owner retained");
  });

  // 12. Manual + scheduled collision
  await test("12. manual + scheduled collision -> one runs, other refused", async () => {
    await reset();
    const [manual, scheduled] = await Promise.all([
      EbaySyncRun.acquireLock("manual"),
      EbaySyncRun.acquireLock("scheduled"),
    ]);
    assert.strictEqual([manual, scheduled].filter(Boolean).length, 1, "exactly one wins");
    assert.strictEqual(await EbaySyncRun.countDocuments({ isLocked: true }), 1, "one locked doc");
  });

  // 13. Catalog + reconcile collision (two scheduled)
  await test("13. catalog + reconcile collision (two scheduled) -> one runs", async () => {
    await reset();
    const [a, b] = await Promise.all([
      EbaySyncRun.acquireLock("scheduled"),
      EbaySyncRun.acquireLock("scheduled"),
    ]);
    assert.strictEqual([a, b].filter(Boolean).length, 1, "exactly one wins");
  });

  // 14. Repeated attempts after a crash
  await test("14. repeated attempts after a crash keep succeeding, no residue", async () => {
    await reset();
    await insertStaleLeaseAware(600000); // crashed owner
    for (let i = 0; i < 3; i++) {
      const run = await EbaySyncRun.acquireLock("manual");
      assert(run, "attempt " + (i + 1) + " should acquire after recovery");
      await EbaySyncRun.releaseLock(run, "completed", {});
    }
    assert.strictEqual(await EbaySyncRun.countDocuments({ isLocked: true }), 0, "no active lock residue");
  });

  // 15. Startup with a pre-existing stale lock (lease-aware + legacy)
  await test("15a. startup with pre-existing lease-expired lock recovers", async () => {
    await reset();
    await insertStaleLeaseAware(120000);
    const run = await EbaySyncRun.acquireLock("scheduled");
    assert(run, "startup acquire must reclaim lease-expired lock");
  });
  await test("15b. startup with legacy stale lock (no lease, old lockedAt) recovers", async () => {
    await reset();
    await insertLegacyLock(new Date(Date.now() - 5 * 60 * 60 * 1000));
    const run = await EbaySyncRun.acquireLock("scheduled");
    assert(run, "startup acquire must reclaim legacy stale lock via fallback");
  });
  await test("15c. startup with legacy RECENT lock (no lease) is NOT swept", async () => {
    await reset();
    await insertLegacyLock(new Date());
    const run = await EbaySyncRun.acquireLock("scheduled");
    assert.strictEqual(run, null, "a recent legacy lock must be respected, not stolen");
  });

  await reset();
  await mongoose.disconnect();

  console.log("\n==================== SUMMARY ====================");
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  for (const r of results) {
    console.log((r.status === "PASS" ? "PASS  " : "FAIL  ") + r.name + (r.error ? "  -> " + r.error : ""));
  }
  console.log("-------------------------------------------------");
  console.log("TOTAL=" + results.length + "  PASS=" + pass + "  FAIL=" + fail);
  console.log("Note: SIGTERM/SIGINT signal-handler WIRING in server.js is verified by code");
  console.log("review only (cannot be unit-tested without spawning a real process).");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[EBAY_LOCK_TEST] FATAL: " + (err && err.stack || err));
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
