// MANUAL MIGRATION — Scrap Purchase sellers → dedicated ScrapPurchaseSeller.
//
// PURPOSE
//   Existing ScrapPurchase records reference a shared Customer._id in the
//   `supplier` field. The Scrap Purchase module now uses a dedicated
//   ScrapPurchaseSeller collection, so those records need their `supplier`
//   repointed to a ScrapPurchaseSeller._id.
//
// SAFETY / GUARANTEES
//   - READ-ONLY on everything except: creating ScrapPurchaseSeller docs and
//     setting ScrapPurchase.supplier to the matching new seller _id.
//   - NEVER deletes ScrapPurchase records.
//   - NEVER deletes or modifies Customer records.
//   - NEVER drops or renames collections.
//   - NEVER modifies supplierSnapshot (kept exactly as the historical fallback).
//   - Records missing a usable seller name are SKIPPED and reported.
//   - Idempotent: re-running will not create duplicate sellers (deduped by
//     name + phone) and will not re-point records that already reference a
//     ScrapPurchaseSeller.
//   - This script is MANUAL. It is NOT wired into server startup or any job.
//
// HOW TO RUN (after reviewing the implementation):
//   cd auto-hub-backend
//   node scripts/migrateScrapPurchaseSellers.js            # dry run (default)
//   node scripts/migrateScrapPurchaseSellers.js --apply    # perform the writes
//
// The default is a DRY RUN: it reports exactly what WOULD change and writes
// nothing. Pass --apply to actually perform the migration.

require("dotenv").config();
const mongoose = require("mongoose");
const ScrapPurchase = require("../models/scrapPurchase.model");
const ScrapPurchaseSeller = require("../models/scrapPurchaseSeller.model");

const APPLY = process.argv.includes("--apply");

const normalizeName = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ");

const pickSnapshotName = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return "";
  const direct = normalizeName(snapshot.name);
  if (direct) return direct;
  const joined = normalizeName(
    [snapshot.firstName, snapshot.lastName].filter(Boolean).join(" ")
  );
  return joined;
};

const pickSnapshotPhone = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return "";
  return String(snapshot.phone || snapshot.mobileNo || "").trim();
};

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("No MONGODB_URI / MONGO_URI configured. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected to database: ${mongoose.connection.db.databaseName}`);
  console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);

  // Load the set of valid ScrapPurchaseSeller ids so we can skip records that
  // are already correctly pointed at the dedicated collection (idempotency).
  const existingSellerIds = new Set(
    (await ScrapPurchaseSeller.find({}, { _id: 1 }).lean()).map((s) =>
      String(s._id)
    )
  );

  // Only consider records that currently point somewhere (legacy Customer ids)
  // OR have no supplier at all but do have a usable snapshot.
  const records = await ScrapPurchase.find(
    { isDeleted: { $ne: true } },
    { supplier: 1, supplierSnapshot: 1, billNumber: 1 }
  ).lean();

  const stats = {
    scanned: records.length,
    alreadyDedicated: 0,
    skippedNoName: 0,
    sellersCreated: 0,
    repointed: 0,
    reusedExistingSeller: 0,
    failed: 0,
  };

  const skipped = [];
  // Cache created/matched sellers by `${name}|${phone}` to dedupe within a run.
  const sellerCache = new Map();

  for (const record of records) {
    try {
      // Already referencing a ScrapPurchaseSeller — nothing to do.
      if (record.supplier && existingSellerIds.has(String(record.supplier))) {
        stats.alreadyDedicated += 1;
        continue;
      }

      const name = pickSnapshotName(record.supplierSnapshot);
      const phone = pickSnapshotPhone(record.supplierSnapshot);

      if (!name) {
        stats.skippedNoName += 1;
        skipped.push({
          id: String(record._id),
          billNumber: record.billNumber || null,
          reason: "No usable seller name in supplierSnapshot",
        });
        continue;
      }

      const key = `${name}|${phone}`;
      let sellerId = sellerCache.get(key);

      if (!sellerId) {
        // Dedupe against what already exists in the dedicated collection.
        const existing = await ScrapPurchaseSeller.findOne({ name, phone }).lean();
        if (existing) {
          sellerId = String(existing._id);
          stats.reusedExistingSeller += 1;
        } else if (APPLY) {
          const created = await ScrapPurchaseSeller.create({ name, phone });
          sellerId = String(created._id);
          stats.sellersCreated += 1;
        } else {
          // Dry run: pretend we created it so later records dedupe correctly.
          sellerId = `DRYRUN:${key}`;
          stats.sellersCreated += 1;
        }
        sellerCache.set(key, sellerId);
      }

      if (APPLY && !String(sellerId).startsWith("DRYRUN:")) {
        await ScrapPurchase.updateOne(
          { _id: record._id },
          { $set: { supplier: sellerId } }
        );
      }
      stats.repointed += 1;
    } catch (err) {
      stats.failed += 1;
      skipped.push({
        id: String(record._id),
        reason: `Error: ${err.message}`,
      });
    }
  }

  console.log("\n=== Migration summary ===");
  console.log(JSON.stringify(stats, null, 2));

  if (skipped.length) {
    console.log("\n=== Skipped / errored records ===");
    console.log(JSON.stringify(skipped, null, 2));
  }

  console.log(
    APPLY
      ? "\nMigration applied. supplierSnapshot values were left untouched."
      : "\nDry run complete. No writes performed. Re-run with --apply to migrate."
  );

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("Migration failed:", err);
  try {
    await mongoose.disconnect();
  } catch (e) {
    /* ignore */
  }
  process.exit(1);
});
