/**
 * One-time bulk automation of the manual "Add To Inventory" workflow.
 *
 * Manual workflow being automated (unchanged, not touched):
 *   Car List (status = payment-done) -> Add To Inventory -> tick Extracted
 *   -> tick Cleaned -> (parts already listed) -> Submit -> Inventory created
 *   -> CarIntake.status -> "part-added-to-inventory"
 *   (src/pages/PartInventory/Add.jsx -> src/pages/PartInventory/AddInventoryPage.jsx)
 *
 * This script reuses the EXACT existing backend logic — nothing is
 * duplicated or reimplemented:
 *   - Eligibility filter: CarIntake.status === "payment-done" — the same
 *     filter PartInventory/Add.jsx's Car List uses
 *     (carIntakeAPI.getAll({ status: "payment-done" })).
 *   - Parts to include: every partDetails.parts[key] with selected === true
 *     — the same set AddInventoryPage.jsx renders as rows. Extracted and
 *     Cleaned are both treated as true for every part automatically,
 *     instead of requiring the two checkboxes to be ticked manually.
 *   - Quality: read verbatim from partDetails.parts[key].quality, exactly
 *     as stored during Car Intake — never regenerated or modified.
 *   - Inventory creation: calls the real, unmodified
 *     controllers/inventory.controller.js#createInventory function
 *     directly (via a minimal mock req/res) — same make/model/trim
 *     resolution, same sku/category defaults, same unique {vin, partName}
 *     duplicate index as the real UI path.
 *   - Status transition: calls the real, unmodified
 *     controllers/carIntake.controller.js#updateCarIntakeStatus function
 *     directly, exactly as AddInventoryPage.jsx does after a successful
 *     submit (-> "part-added-to-inventory").
 *
 * Nothing in models/, controllers/, routes/, services/, middleware/, or
 * the frontend is modified by this script — it only calls existing,
 * unmodified functions.
 *
 * Usage:
 *   node scripts/bulkAddCarsToInventory.js            (dry run — report only, no writes)
 *   node scripts/bulkAddCarsToInventory.js --apply    (create inventory + update status)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const CarIntake = require("../models/CarIntake.model");
const Inventory = require("../models/Inventory.model");
const { createInventory } = require("../controllers/inventory.controller");
const { updateCarIntakeStatus } = require("../controllers/carIntake.controller");

const APPLY = process.argv.includes("--apply");
const ELIGIBILITY_FILTER = { status: "payment-done" };

// Minimal Express-like req/res so the *real* controller functions run
// unmodified with no HTTP server involved, and no logic duplicated.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function createInventoryFor(payload) {
  const req = { body: payload };
  const res = mockRes();
  await createInventory(req, res);
  if (res.statusCode >= 400) {
    const err = new Error(res.body?.message || `createInventory failed (${res.statusCode})`);
    err.statusCode = res.statusCode;
    throw err;
  }
  return res.body?.data;
}

async function markPartAddedToInventory(carIntakeId) {
  const req = {
    params: { id: carIntakeId },
    body: { status: "part-added-to-inventory" },
  };
  const res = mockRes();
  await updateCarIntakeStatus(req, res);
  if (res.statusCode >= 400) {
    throw new Error(res.body?.error || `updateCarIntakeStatus failed (${res.statusCode})`);
  }
  return res.body?.carIntake;
}

function selectedPartsOf(carIntake) {
  const parts = (carIntake.partDetails && carIntake.partDetails.parts) || {};
  return Object.keys(parts)
    .filter((key) => parts[key]?.selected)
    .map((key) => ({ key, ...parts[key] }));
}

function isDuplicateKeyError(err) {
  return err?.statusCode !== undefined
    ? false // errors surfaced from createInventory already have a clean message
    : err?.code === 11000 || /duplicate/i.test(err?.message || "");
}

async function run() {
  const stats = {
    carsFound: 0,
    carsEligible: 0,
    carsSkipped: 0,
    partsFound: 0,
    partsToCreate: 0,
    partsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB\n");
    console.log(APPLY ? "MODE: APPLY (writes will be made)\n" : "MODE: DRY RUN (no writes)\n");

    const cars = await CarIntake.find(ELIGIBILITY_FILTER).lean();
    stats.carsFound = cars.length;

    console.log(`Eligible Cars (status = "payment-done"): ${cars.length}\n`);

    for (const car of cars) {
      const parts = selectedPartsOf(car);
      stats.partsFound += parts.length;

      if (!parts.length) {
        stats.carsSkipped += 1;
        console.log(`SKIP  ${car.vin} (${car._id}) — no selected parts`);
        continue;
      }

      stats.carsEligible += 1;

      // One query per car for existing inventory (not one per part).
      const existingInventory = await Inventory.find({ vin: car.vin })
        .select("partName")
        .lean();
      const existingPartNames = new Set(existingInventory.map((i) => i.partName));

      console.log(`\nCar ${car.vin} (${car._id}) — ${parts.length} selected part(s):`);

      let createdForThisCar = 0;
      let alreadyPresentForThisCar = 0;
      let carHadError = false;

      for (const part of parts) {
        if (existingPartNames.has(part.key)) {
          stats.duplicatesSkipped += 1;
          alreadyPresentForThisCar += 1;
          console.log(`  SKIP (duplicate)  ${part.key}`);
          continue;
        }

        stats.partsToCreate += 1;
        console.log(
          `  ${APPLY ? "CREATE" : "WOULD CREATE"}  ${part.key}  quality=${
            part.quality || "(none)"
          } unit=${part.unit || 0}`
        );

        if (!APPLY) continue;

        try {
          await createInventoryFor({
            partName: part.key,
            unit: part.unit || 0,
            cleaned: true,
            quality: part.quality,
            location: part.placed,
            weight: part.weight,
            dimensions: part.dimensions,
            make: car.carDetails?.make,
            model: car.carDetails?.model,
            trim: car.carDetails?.trim,
            year: car.carDetails?.year,
            vin: car.vin,
            color: car.carDetails?.color,
            image: null,
          });
          stats.partsCreated += 1;
          createdForThisCar += 1;
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            stats.duplicatesSkipped += 1;
            alreadyPresentForThisCar += 1;
            console.log(`  SKIP (duplicate on insert)  ${part.key}`);
          } else {
            carHadError = true;
            stats.errors.push({ vin: car.vin, part: part.key, message: err.message });
            console.error(`  ERROR  ${part.key}: ${err.message}`);
          }
        }
      }

      const allAccountedFor =
        createdForThisCar + alreadyPresentForThisCar === parts.length;

      if (APPLY && !carHadError && allAccountedFor) {
        try {
          await markPartAddedToInventory(car._id);
          console.log(`  Status -> part-added-to-inventory`);
        } catch (err) {
          stats.errors.push({ vin: car.vin, part: null, message: err.message });
          console.error(`  ERROR updating status: ${err.message}`);
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(APPLY ? "APPLY RUN COMPLETE" : "DRY RUN COMPLETE (no writes made)");
    console.log("=".repeat(60));
    console.log(`Cars found:            ${stats.carsFound}`);
    console.log(`Cars eligible:         ${stats.carsEligible}`);
    console.log(`Cars skipped:          ${stats.carsSkipped}`);
    console.log(`Parts found:           ${stats.partsFound}`);
    console.log(`Parts to create:       ${stats.partsToCreate}`);
    console.log(`Parts created:         ${stats.partsCreated}`);
    console.log(`Duplicates skipped:    ${stats.duplicatesSkipped}`);
    console.log(`Errors:                ${stats.errors.length}`);
    if (stats.errors.length) {
      console.log("\nError details:");
      stats.errors.forEach((e) =>
        console.log(`  - ${e.vin} / ${e.part || "status update"}: ${e.message}`)
      );
    }
    if (!APPLY) {
      console.log("\nRe-run with --apply to perform the above changes.");
    }

    process.exit(0);
  } catch (error) {
    console.error("Script failed:", error);
    process.exit(1);
  }
}

run();
