/**
 * One-time cleanup: delete unwanted leads.
 *
 *   - Junk Car Requests (JunkCar) whose status is "Completed"
 *   - Part Requests (PartRequest) whose status is "Completed" or "Rejected"
 *
 * Status matching ignores case and surrounding spaces. Nothing else is
 * touched: Car Intake records created from completed junk car leads stay
 * as they are (they don't reference the lead).
 *
 * Safety:
 *   - Dry run by default: prints counts and a preview, writes nothing.
 *   - With --apply it first writes every matching document to a JSON backup
 *     file, then deletes exactly those _ids (not "whatever matches now"), so
 *     a lead whose status changes in between is not deleted.
 *   - Restore: mongoimport --uri "$MONGODB_URI" --collection <name>
 *       --file <backup> --jsonArray   (Extended JSON, keeps _id and dates)
 *
 * Usage (from the backend folder):
 *   node scripts/removeCompletedRejectedLeads.js                 dry run
 *   node scripts/removeCompletedRejectedLeads.js --apply         back up + delete
 *   node scripts/removeCompletedRejectedLeads.js --apply --backup-dir /path
 *     (default backup folder: ~/autohub-lead-backups)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const JunkCar = require("../models/JunkCar.model");
const PartRequest = require("../models/PartRequest.model");
const { JUNK_CAR_REMOVED_STATUSES, statusRegex } = require("../utils/junkCarLeads");
const { PART_REQUEST_REMOVED_STATUSES } = require("../utils/partRequestLeads");

const APPLY = process.argv.includes("--apply");
const backupDirArg = process.argv.indexOf("--backup-dir");
const BACKUP_DIR =
  backupDirArg !== -1 && process.argv[backupDirArg + 1]
    ? path.resolve(process.argv[backupDirArg + 1])
    : path.join(os.homedir(), "autohub-lead-backups");

const TARGETS = [
  {
    label: "Junk Car Requests",
    model: JunkCar,
    statuses: JUNK_CAR_REMOVED_STATUSES,
    preview: "name phone make model year status paymentStatus movedToIntake createdAt",
  },
  {
    label: "Part Requests",
    model: PartRequest,
    statuses: PART_REQUEST_REMOVED_STATUSES,
    preview: "name phone make model year partName status createdAt",
  },
];

function redact(uri) {
  return uri ? uri.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:<redacted>@") : uri;
}

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGODB_URI is not set (backend .env)");

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB:", redact(mongoUri));
  console.log(APPLY ? "MODE: APPLY (backup, then delete)\n" : "MODE: DRY RUN (no changes)\n");

  const found = [];

  for (const target of TARGETS) {
    const filter = { status: statusRegex(target.statuses) };
    const collection = target.model.collection.collectionName;
    const docs = await target.model.find(filter).lean();

    const byStatus = docs.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});

    console.log(`${target.label} (collection "${collection}") with status ${target.statuses.join(" / ")}: ${docs.length}`);
    if (docs.length) console.log("  by status:", byStatus);

    const fields = target.preview.split(" ");
    docs.slice(0, 10).forEach((d) => {
      const row = { _id: String(d._id) };
      fields.forEach((f) => { if (d[f] !== undefined) row[f] = d[f]; });
      console.log("   " + JSON.stringify(row));
    });
    if (docs.length > 10) console.log(`   ... and ${docs.length - 10} more`);
    console.log("");

    found.push({ ...target, collection, docs });
  }

  const total = found.reduce((n, t) => n + t.docs.length, 0);
  if (total === 0) {
    console.log("Nothing to remove.");
    return;
  }

  if (!APPLY) {
    console.log(`DRY RUN ONLY — ${total} lead(s) would be deleted. Re-run with --apply to back up and delete them.`);
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const target of found) {
    if (!target.docs.length) continue;

    // Extended JSON keeps ObjectIds and dates restorable with mongoimport.
    const file = path.join(BACKUP_DIR, `${target.collection}-removed-${stamp}.json`);
    const json = `[\n${target.docs.map((d) => JSON.stringify(mongoose.mongo.BSON.EJSON.serialize(d))).join(",\n")}\n]\n`;
    fs.writeFileSync(file, json);

    // Verify the backup before deleting anything.
    const reread = JSON.parse(fs.readFileSync(file, "utf8"));
    if (reread.length !== target.docs.length) {
      throw new Error(`Backup check failed for ${target.collection}: wrote ${reread.length} of ${target.docs.length}. Nothing deleted.`);
    }
    console.log(`Backup written: ${file} (${reread.length} document(s))`);

    const ids = target.docs.map((d) => d._id);
    // Re-check the status in the delete itself so a lead changed since the
    // backup is kept.
    const result = await target.model.deleteMany({
      _id: { $in: ids },
      status: statusRegex(target.statuses),
    });
    console.log(`Deleted from ${target.collection}: ${result.deletedCount} of ${ids.length}\n`);
  }

  console.log("Done.");
}

run()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Cleanup failed:", error.message || error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
