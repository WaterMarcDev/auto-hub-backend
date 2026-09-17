/**
 * READ-ONLY diagnostic. Makes NO writes to the database.
 *
 * Investigates a possible mismatch between the Quality stored on a
 * CarIntake document's partDetails.parts[key].quality and the Quality
 * stored on the Inventory documents created for that same VIN (whether
 * created via scripts/bulkAddCarsToInventory.js or the normal
 * Add-To-Inventory UI flow — both write to the same Inventory model).
 *
 * Usage:
 *   node scripts/investigateQualityMismatch.js <VIN>
 *
 *   node scripts/investigateQualityMismatch.js
 *     (no VIN given -> auto-picks one CarIntake with
 *      status: "part-added-to-inventory" that has at least one
 *      matching Inventory document, i.e. one that was actually
 *      processed through to inventory creation)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const CarIntake = require("../models/carIntake.model");
const Inventory = require("../models/inventory.model");

async function pickAVin() {
  const candidates = await CarIntake.find({ status: "part-added-to-inventory" })
    .select("vin")
    .lean();

  for (const c of candidates) {
    const count = await Inventory.countDocuments({ vin: c.vin });
    if (count > 0) return c.vin;
  }
  return null;
}

async function run() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB:", mongoUri.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:<redacted>@"));

    let vin = process.argv[2];
    if (!vin) {
      vin = await pickAVin();
      if (!vin) {
        console.log("\nNo CarIntake with status 'part-added-to-inventory' and matching Inventory records found.");
        process.exit(0);
      }
      console.log(`\nNo VIN given — auto-selected: ${vin}`);
    }

    const car = await CarIntake.findOne({ vin }).lean();
    if (!car) {
      console.log(`\nNo CarIntake found for VIN ${vin}`);
      process.exit(1);
    }

    console.log(`\n${"=".repeat(70)}`);
    console.log(`VIN: ${vin}`);
    console.log(`CarIntake _id: ${car._id}`);
    console.log(`CarIntake status: ${car.status}`);
    console.log(`${"=".repeat(70)}`);

    const parts = (car.partDetails && car.partDetails.parts) || {};
    const partKeys = Object.keys(parts);

    console.log(`\nSTEP 2 — Raw CarIntake.partDetails.parts (${partKeys.length} total):`);
    console.log("-".repeat(70));
    partKeys.forEach((key) => {
      const p = parts[key] || {};
      console.log(
        `${key.padEnd(24)} quality=${String(p.quality ?? "(none)").padEnd(14)} selected=${String(!!p.selected).padEnd(6)} extracted=${String(!!p.extracted).padEnd(6)} cleaned=${!!p.cleaned}`
      );
    });

    const inventoryDocs = await Inventory.find({ vin }).lean();
    console.log(`\nSTEP 3 — Raw Inventory documents for this VIN (${inventoryDocs.length} total):`);
    console.log("-".repeat(70));
    inventoryDocs.forEach((i) => {
      console.log(`${String(i.partName).padEnd(24)} quality=${String(i.quality ?? "(none)")}`);
    });

    console.log(`\nSTEP 4 — One-to-one comparison:`);
    console.log("-".repeat(70));
    console.log(
      `${"Part Name".padEnd(24)}${"CarIntake Quality".padEnd(20)}${"Inventory Quality".padEnd(20)}Match?`
    );

    const inventoryByPartName = new Map(inventoryDocs.map((i) => [i.partName, i]));
    let anyMismatch = false;
    let anyNonGoodInCarIntake = false;
    let comparedCount = 0;

    partKeys.forEach((key) => {
      const p = parts[key] || {};
      if (!p.selected) return; // only parts that would actually be migrated

      const invDoc = inventoryByPartName.get(key);
      if (!invDoc) {
        console.log(
          `${key.padEnd(24)}${String(p.quality ?? "(none)").padEnd(20)}${"(no Inventory doc)".padEnd(20)}N/A`
        );
        return;
      }

      comparedCount += 1;
      const ciQuality = p.quality ?? "(none)";
      const invQuality = invDoc.quality ?? "(none)";
      const match = ciQuality === invQuality;
      if (!match) anyMismatch = true;
      if (String(ciQuality).toLowerCase() !== "good" && ciQuality !== "(none)") {
        anyNonGoodInCarIntake = true;
      }

      console.log(
        `${key.padEnd(24)}${String(ciQuality).padEnd(20)}${String(invQuality).padEnd(20)}${match ? "YES" : "NO — MISMATCH"}`
      );
    });

    console.log(`\n${"=".repeat(70)}`);
    console.log("CONCLUSION");
    console.log("=".repeat(70));

    if (comparedCount === 0) {
      console.log("No selected parts with a matching Inventory document were found for this VIN — cannot conclude anything from this record. Try a different VIN.");
    } else if (!anyNonGoodInCarIntake) {
      console.log(
        `Every selected part's CarIntake.partDetails.parts[key].quality for this VIN is already "Good" (or unset).\n` +
        `STOP — per Step 5: the source data itself contains only "Good". This is not a script defect for this VIN;\n` +
        `it faithfully reflects what was captured during Car Intake. Re-run this script against a different VIN\n` +
        `that has a non-"Good" quality value in Car Intake, to actually test for a mismatch.`
      );
    } else if (anyMismatch) {
      console.log(
        `MISMATCH CONFIRMED for VIN ${vin}: at least one part has a non-"Good" CarIntake quality but a different\n` +
        `(or "Good") stored Inventory quality. See the "NO — MISMATCH" rows above for exact part names.\n` +
        `Do NOT modify scripts/bulkAddCarsToInventory.js yet — report these exact part names and values back\n` +
        `so the specific assignment point can be traced (was this Inventory doc created by the bulk script or\n` +
        `by the manual Add-To-Inventory UI? Check the record's createdAt/updatedAt against when the bulk script\n` +
        `was run to help distinguish).`
      );
    } else {
      console.log(
        `This VIN has non-"Good" quality values in CarIntake, and every one of them matches its Inventory\n` +
        `document exactly. No mismatch found for this VIN. If you're still observing "Good" elsewhere, please\n` +
        `run: node scripts/investigateQualityMismatch.js <VIN> against the specific VIN where you saw the issue.`
      );
    }

    process.exit(0);
  } catch (error) {
    console.error("Diagnostic failed:", error);
    process.exit(1);
  }
}

run();
