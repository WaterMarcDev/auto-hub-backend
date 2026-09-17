/**
 * One-time historical data migration.
 *
 * Finds every CarIntake document with status === "price-uploaded" and:
 *   1. Sets status -> "payment-done"
 *   2. Sets payment.paymentMethod -> "cash" ONLY if it is currently null/empty
 *      (an existing payment method on a matched record is left untouched)
 *
 * No other status is ever touched. No other field is ever touched. This
 * does not call any controller/workflow code — it writes directly via the
 * existing CarIntake model, using a single bulk updateMany() (aggregation
 * pipeline form, for the conditional set) so no documents are loaded into
 * memory for the write itself.
 *
 * Usage:
 *   node scripts/migratePriceUploadedToPaymentDone.js            (dry run — report only, no writes)
 *   node scripts/migratePriceUploadedToPaymentDone.js --apply    (perform the update)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const CarIntake = require("../models/carIntake.model");

const APPLY = process.argv.includes("--apply");
const MATCH_FILTER = { status: "parts-uploaded" };

function redact(uri) {
  return uri ? uri.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:<redacted>@") : uri;
}

function printRecord(doc) {
  console.log({
    _id: doc._id.toString(),
    vin: doc.vin,
    status: doc.status,
    paymentMethod: doc.payment?.paymentMethod ?? null,
  });
}

async function run() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB:", redact(mongoUri));

    const total = await CarIntake.countDocuments(MATCH_FILTER);
    console.log(`\nRecords with status = "parts-uploaded": ${total}`);

    if (total === 0) {
      console.log("Nothing to migrate. Exiting.");
      process.exit(0);
    }

    const preview = await CarIntake.find(MATCH_FILTER)
      .select("vin status payment.paymentMethod")
      .limit(10)
      .lean();

    console.log(`\nPreview (showing up to 10 of ${total}) BEFORE migration:`);
    preview.forEach(printRecord);

    if (!APPLY) {
      console.log(
        "\nDRY RUN ONLY — no changes made. Re-run with --apply to perform the update."
      );
      process.exit(0);
    }

    const result = await CarIntake.updateMany(MATCH_FILTER, [
      {
        $set: {
          status: "payment-done",
          "payment.paymentMethod": {
            $cond: [
              { $in: [{ $ifNull: ["$payment.paymentMethod", null] }, [null, ""]] },
              "cash",
              "$payment.paymentMethod",
            ],
          },
        },
      },
    ]);

    console.log(
      `\nMatched: ${result.matchedCount}, Modified: ${result.modifiedCount}`
    );

    const sampleIds = preview.map((d) => d._id);
    const after = await CarIntake.find({ _id: { $in: sampleIds } })
      .select("vin status payment.paymentMethod")
      .lean();

    console.log("\nSame sample AFTER migration:");
    after.forEach(printRecord);

    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

run();
