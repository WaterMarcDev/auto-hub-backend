/**
 * One-time cleanup: remove A1, A2, Windshield, Heated Windshield and Heated Rear Windshield from the
 * CRM (see utils/removedParts.js for the exact names matched).
 *
 *   - Part catalog (Part): soft-deleted (deleted / isDeleted = true), so they
 *     disappear from Car Intake Step 3, the Part list and every part picker.
 *   - Parts inventory (Inventory): soft-deleted (isDeleted = true), so they
 *     disappear from Master Parts and the other inventory lists.
 *
 * Car Intake records are not touched: their Step 3 history keeps the old
 * part keys, it just no longer turns into inventory.
 *
 * Safety:
 *   - Dry run by default: prints counts and a preview, writes nothing.
 *   - Inventory items still linked to an eBay listing or a Wix product are
 *     SKIPPED and listed, so a live online listing is never orphaned. End
 *     those listings first, then re-run.
 *   - With --apply it first writes every matching document to a JSON backup
 *     file, then soft-deletes exactly those _ids. Nothing is hard-deleted.
 *   - Undo: set deleted/isDeleted back to false for the _ids in the backup.
 *
 * Usage (from the backend folder):
 *   node scripts/removeDiscontinuedParts.js                 dry run
 *   node scripts/removeDiscontinuedParts.js --apply         back up + soft-delete
 *   node scripts/removeDiscontinuedParts.js --apply --backup-dir /path
 *     (default backup folder: ~/autohub-part-backups)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const Part = require("../models/Part.model");
const Inventory = require("../models/Inventory.model");
const { removedPartsNor } = require("../utils/removedParts");

const APPLY = process.argv.includes("--apply");
const backupDirArg = process.argv.indexOf("--backup-dir");
const BACKUP_DIR =
  backupDirArg !== -1 && process.argv[backupDirArg + 1]
    ? path.resolve(process.argv[backupDirArg + 1])
    : path.join(os.homedir(), "autohub-part-backups");

// $nor of the "removed" regexes matches everything EXCEPT removed parts, so
// the match for removed parts is $or of the same clauses.
const removedOr = (field) => ({ $or: removedPartsNor(field) });

const hasOnlineListing = (d) => Boolean(d.ebayListingId || d.ebayOfferId || d.wixProductId);

function redact(uri) {
  return uri ? uri.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:<redacted>@") : uri;
}

function countBy(docs, key) {
  return docs.reduce((acc, d) => {
    const k = d[key] || "(empty)";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function writeBackup(collection, docs, stamp) {
  const file = path.join(BACKUP_DIR, `${collection}-discontinued-parts-${stamp}.json`);
  const json = `[\n${docs.map((d) => JSON.stringify(mongoose.mongo.BSON.EJSON.serialize(d))).join(",\n")}\n]\n`;
  fs.writeFileSync(file, json);
  const reread = JSON.parse(fs.readFileSync(file, "utf8"));
  if (reread.length !== docs.length) {
    throw new Error(`Backup check failed for ${collection}: wrote ${reread.length} of ${docs.length}. Nothing changed.`);
  }
  console.log(`Backup written: ${file} (${reread.length} document(s))`);
}

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGODB_URI is not set (backend .env)");

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB:", redact(mongoUri));
  console.log(APPLY ? "MODE: APPLY (backup, then soft-delete)\n" : "MODE: DRY RUN (no changes)\n");

  const parts = await Part.find({ deleted: { $ne: true }, ...removedOr("name") }).lean();
  console.log(`Part catalog entries to remove: ${parts.length}`);
  parts.forEach((p) => console.log(`   ${p._id}  ${p.name}`));
  console.log("");

  const inventory = await Inventory.find({ isDeleted: { $ne: true }, ...removedOr("partName") }).lean();
  const listed = inventory.filter(hasOnlineListing);
  const removable = inventory.filter((d) => !hasOnlineListing(d));

  console.log(`Inventory items matching: ${inventory.length}`);
  console.log("  by part name:", countBy(inventory, "partName"));
  console.log(`  to remove: ${removable.length}`);
  console.log(`  skipped (still on eBay / Wix): ${listed.length}`);
  listed.forEach((d) =>
    console.log(
      `   SKIP ${d._id}  ${d.partName}  sku=${d.sku || "-"}  ebayListingId=${d.ebayListingId || "-"}  wixProductId=${d.wixProductId || "-"}`
    )
  );
  console.log("");

  if (!parts.length && !removable.length) {
    console.log("Nothing to remove.");
    return;
  }

  if (!APPLY) {
    console.log(
      `DRY RUN ONLY — ${parts.length} part(s) and ${removable.length} inventory item(s) would be soft-deleted. Re-run with --apply.`
    );
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const now = new Date();

  if (parts.length) {
    writeBackup(Part.collection.collectionName, parts, stamp);
    const r = await Part.updateMany(
      { _id: { $in: parts.map((p) => p._id) } },
      { $set: { deleted: true, isDeleted: true, deletedAt: now } }
    );
    console.log(`Part catalog soft-deleted: ${r.modifiedCount} of ${parts.length}\n`);
  }

  if (removable.length) {
    writeBackup(Inventory.collection.collectionName, removable, stamp);
    const r = await Inventory.updateMany(
      { _id: { $in: removable.map((d) => d._id) } },
      { $set: { isDeleted: true, deletedAt: now } }
    );
    console.log(`Inventory soft-deleted: ${r.modifiedCount} of ${removable.length}\n`);
  }

  console.log("Done.");
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error("Failed:", err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
