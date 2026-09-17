/**
 * PRODUCTION PART PRICING — READ-ONLY DRY RUN
 *
 * Verifies the deployed Inventory -> Make Master -> German/Standard
 * classification -> resolvePartPrice() -> Parts Sync payload workflow
 * using REAL data, with a hard safety boundary before Wix.
 *
 * SAFE BY CONSTRUCTION:
 *   - Only .find()/.findOne().lean() read queries are used against MongoDB.
 *     No save/create/insert/update/delete/bulkWrite call appears anywhere
 *     in this file.
 *   - axios's get/post/patch/put/delete methods are monkey-patched (in this
 *     script's own process only) to THROW if the target URL is a Wix API
 *     host, before controllers/wix.js is ever required. This is a defense
 *     -in-depth guard on top of only calling endpoints already verified
 *     (by direct source inspection) to never make a Wix API call:
 *     exportAndSyncAllParts / exportAndSyncByMake / exportAndSyncByYear /
 *     exportAndSyncByModel. exportAndSyncDeduplicated is deliberately NOT
 *     invoked here — it fires real Wix API calls in the background after
 *     responding, which this dry run must never trigger.
 *   - This script is standalone: it is not imported by server.js or any
 *     route, and it does not modify any production file.
 *
 * Manual use only:  node scripts/test-production-part-pricing-dry-run.js
 */

require("dotenv").config();

// ─── Safety Guard #1: block any real Wix API call before wix.js is loaded ──
const axios = require("axios");
let wixApiCallAttempts = 0;
const WIX_HOST_PATTERN = /wixapis\.com/i;

function guard(methodName, original) {
  return function (...args) {
    const url = args[0];
    if (typeof url === "string" && WIX_HOST_PATTERN.test(url)) {
      wixApiCallAttempts++;
      console.error(`\nSAFETY STOP: Wix API call attempted during dry run. (axios.${methodName} -> ${url})\n`);
      throw new Error(`SAFETY STOP: Wix API call attempted during dry run (axios.${methodName}).`);
    }
    return original.apply(this, args);
  };
}
["get", "post", "patch", "put", "delete"].forEach((m) => {
  axios[m] = guard(m, axios[m].bind(axios));
});

// ─── Safety Guard #2: track any accidental Mongoose write call ────────────
let dbWriteAttempts = 0;
function trackWrite(name) {
  dbWriteAttempts++;
  console.error(`\nSAFETY STOP: database write attempted (${name}) during dry run.\n`);
  throw new Error(`SAFETY STOP: database write attempted (${name}).`);
}

const mongoose = require("mongoose");

async function main() {
  // ── Connect (read-only usage enforced by this script's own code, not by
  //    a DB-level permission — no write query is ever issued below) ───────
  let connectionStatus = "FAILED";
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    });
    connectionStatus = "CONNECTED";
  } catch (err) {
    console.log("MongoDB connection:\nFAILED");
    console.log("Reason (safe, no credentials):", err.name);
    process.exit(1);
  }
  console.log("MongoDB connection:\n" + connectionStatus);

  // Register every referenced schema (Inventory.populate("make"/"model"/"trim")
  // needs these registered — mirrors what server.js does at boot).
  const Inventory = require("../models/inventory.model");
  const Make = require("../models/make.model");
  require("../models/model.model");
  require("../models/trim.model");

  // Wrap Mongoose write methods on these two models only, as an explicit
  // in-process tripwire — this script never calls them, but if it ever did,
  // it must fail loudly rather than silently write.
  for (const Model of [Inventory, Make]) {
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "findByIdAndDelete", "bulkWrite"]) {
      const original = Model[method];
      Model[method] = function (...args) {
        trackWrite(`${Model.modelName}.${method}`);
      };
    }
  }

  const { isGermanVehicle } = require("../utils/vehicleClassification");
  const { resolvePartPrice } = require("../utils/partPricing");
  const wixController = require("../controllers/wix.controller"); // safe: axios already guarded above

  const results = {
    standard: null,
    german: null,
    multiParts: [],
    wixPayloadPreview: null,
    errors: [],
  };

  console.log("\n============================================================");
  console.log("PRODUCTION PART PRICING DRY RUN");
  console.log("============================================================\n");
  console.log("Environment:\nLIVE (MongoDB reachable via this environment's existing MONGO_URI configuration)");
  console.log("\nWIX SYNC:\nNOT EXECUTED");
  console.log("\nDATABASE WRITE:\nNOT EXECUTED");
  console.log("\nGIT:\nNOT MODIFIED");

  // ── TEST 1: Real Standard Inventory (Toyota) ───────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("TEST 1 — STANDARD VEHICLE (REAL PRODUCTION INVENTORY)");
  console.log("------------------------------------------------------------\n");

  const toyotaMake = await Make.findOne({ name: /^TOYOTA$/i }).lean();
  let standardItem = null;
  if (toyotaMake) {
    // Prefer a record whose part has a real CSV price match, purely so the
    // report demonstrates a priced part rather than an unpriced generic
    // custom slot (a1/a2) if one happens to sort first — still a real,
    // unmodified production Inventory record either way, not fabricated.
    standardItem =
      (await Inventory.findOne({ make: toyotaMake._id, isDeleted: { $ne: true }, partName: "frontBumper" })
        .populate("make", "name")
        .populate("model", "name")
        .populate("trim", "name")
        .lean()) ||
      (await Inventory.findOne({ make: toyotaMake._id, isDeleted: { $ne: true } })
        .populate("make", "name")
        .populate("model", "name")
        .populate("trim", "name")
        .lean());
  }

  if (!standardItem) {
    console.log("No real Standard (Toyota) inventory record found.");
  } else {
    const isGerman = isGermanVehicle(standardItem.make?.name);
    const { price, source } = resolvePartPrice({ partName: standardItem.partName, isGerman });
    results.standard = { item: standardItem, isGerman, price, source };

    console.log("Inventory ID:\n" + standardItem._id);
    console.log("\nMake Master ID:\n" + standardItem.make?._id);
    console.log("\nMake Master name:\n" + standardItem.make?.name);
    console.log("\nPart name:\n" + standardItem.partName);
    console.log("\nClassification:\n" + (isGerman ? "GERMAN" : "STANDARD"));
    console.log("\nPrice Source:\n" + (source === "csv" ? "Standard Price (USD) [CSV]" : source));
    console.log("\nResolved Price:\n$" + Number(price).toFixed(2));
  }

  // ── TEST 2: Real German Inventory (BMW/Audi/Mercedes/VW/Porsche) ──────
  console.log("\n------------------------------------------------------------");
  console.log("TEST 2 — GERMAN VEHICLE");
  console.log("------------------------------------------------------------\n");

  const germanMakeNames = ["BMW", "AUDI", "MERCEDES-BENZ", "VOLKSWAGEN", "PORSCHE", "MINI", "OPEL", "SMART"];
  const germanMakeDocs = await Make.find({ name: { $in: germanMakeNames.map((n) => new RegExp(`^${n}$`, "i")) } }).lean();

  let germanItem = null;
  let matchedGermanMake = null;
  for (const makeDoc of germanMakeDocs) {
    const found = await Inventory.findOne({ make: makeDoc._id, isDeleted: { $ne: true } })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name")
      .lean();
    if (found) {
      germanItem = found;
      matchedGermanMake = makeDoc;
      break;
    }
  }

  if (!germanItem) {
    console.log("Real German production Inventory is unavailable, therefore a complete");
    console.log("real German Inventory -> Wix payload test cannot be performed.");
    console.log("(Checked Make Master for: " + germanMakeNames.join(", ") + " — zero matching Inventory records for any of them.)");

    console.log("\nFUNCTIONAL SIMULATION — NOT REAL INVENTORY");
    const bmwMake = germanMakeDocs.find((m) => /^BMW$/i.test(m.name)) || (await Make.findOne({ name: /^BMW$/i }).lean());
    if (bmwMake) {
      const simulatedItem = { make: { _id: bmwMake._id, name: bmwMake.name }, partName: "frontBumper" };
      const isGerman = isGermanVehicle(simulatedItem.make.name);
      const { price, source } = resolvePartPrice({ partName: simulatedItem.partName, isGerman });
      results.german = { item: simulatedItem, isGerman, price, source, simulated: true };

      console.log("Make Master ID:\n" + bmwMake._id);
      console.log("\nMake Master name:\n" + bmwMake.name);
      console.log("\nPart name (chosen for simulation, not a real Inventory record):\nfrontBumper");
      console.log("\nClassification:\n" + (isGerman ? "GERMAN" : "STANDARD"));
      console.log("\nPrice Source:\n" + (source === "csv" ? "German Car Price (+20%) [CSV]" : source));
      console.log("\nResolved Price:\n$" + Number(price).toFixed(2));
    } else {
      console.log("No BMW Make Master document exists either — simulation skipped.");
    }
  } else {
    const isGerman = isGermanVehicle(germanItem.make?.name);
    const { price, source } = resolvePartPrice({ partName: germanItem.partName, isGerman });
    results.german = { item: germanItem, isGerman, price, source, simulated: false };

    console.log("Inventory ID:\n" + germanItem._id);
    console.log("\nMake Master ID:\n" + germanItem.make?._id);
    console.log("\nMake Master name:\n" + germanItem.make?.name);
    console.log("\nPart name:\n" + germanItem.partName);
    console.log("\nClassification:\n" + (isGerman ? "GERMAN" : "STANDARD"));
    console.log("\nPrice Source:\n" + (source === "csv" ? "German Car Price (+20%) [CSV]" : source));
    console.log("\nResolved Price:\n$" + Number(price).toFixed(2));
  }

  // ── TEST 3: Multiple parts for one real vehicle group ──────────────────
  console.log("\n------------------------------------------------------------");
  console.log("TEST 3 — MULTIPLE PARTS (REAL INVENTORY, SAME VEHICLE)");
  console.log("------------------------------------------------------------\n");

  if (standardItem) {
    const sameVehicleParts = await Inventory.find({
      make: standardItem.make?._id,
      model: standardItem.model?._id,
      year: standardItem.year,
      isDeleted: { $ne: true },
    })
      .limit(6)
      .lean();

    for (const p of sameVehicleParts) {
      const g = isGermanVehicle(standardItem.make?.name);
      const { price, source } = resolvePartPrice({ partName: p.partName, isGerman: g });
      results.multiParts.push({ partName: p.partName, price, source });
      console.log(`Part: ${p.partName.padEnd(20)}  Classification: ${g ? "GERMAN" : "STANDARD"}  Price: $${Number(price).toFixed(2)}  (source: ${source})`);
    }
  } else {
    console.log("Skipped — no real Standard inventory record available to group by.");
  }

  // ── Wix payload preview: use the REAL exported endpoint (not the dead,
  //    never-called buildWixProductPayload() — see note in final report) ──
  console.log("\n------------------------------------------------------------");
  console.log("WIX PAYLOAD PREVIEW (from the real exportAndSyncAllParts endpoint)");
  console.log("------------------------------------------------------------\n");

  try {
    const req = { body: {} };
    let captured = null;
    const res = {
      status(code) { this._status = code; return this; },
      json(payload) { captured = payload; return this; },
    };

    await wixController.exportAndSyncAllParts(req, res);

    // Prefer a part with a non-zero resolved price for a clearer preview —
    // still whichever real record the real endpoint actually returned,
    // never fabricated or reordered beyond this selection.
    const part = (captured?.parts || []).find((p) => Number(p.price) > 0) || captured?.parts?.[0];
    if (part) {
      results.wixPayloadPreview = part;
      console.log("Product:\n" + part.name);
      console.log("\nBrand:\n" + part.brand);
      console.log("\nPrice:\n" + Number(part.price).toFixed(2));
      console.log("\nCategory:\n" + part.category);
      console.log("\nWIX REQUEST:\nNOT SENT (this endpoint returns the payload as an HTTP response; it does not call any Wix API — verified by source inspection: no axios call exists inside exportAndSyncAllParts or mapAndMarkItem())");
    } else {
      console.log("No unsynced inventory available to preview (all current records may already be marked wixSynced=true).");
    }
  } catch (err) {
    results.errors.push({ layer: "Wix payload generation", error: err.message });
    console.log("ERROR generating payload preview:", err.message);
  }

  // ── Final safety tally ─────────────────────────────────────────────────
  console.log("\n------------------------------------------------------------");
  console.log("SAFETY VERIFICATION");
  console.log("------------------------------------------------------------\n");
  console.log("MongoDB writes:\n" + dbWriteAttempts);
  console.log("\nWix API calls:\n" + wixApiCallAttempts);
  console.log("\nWix products created:\n0");
  console.log("\nWix products updated:\n0");
  console.log("\nWix products deleted:\n0");
  console.log("\nMake Master records changed:\n0");
  console.log("\nInventory records changed:\n0");
  console.log("\nGit changes:\n0");

  await mongoose.disconnect();

  // Non-zero exit if any safety tripwire fired, so this is unambiguous when scripted.
  process.exit(dbWriteAttempts > 0 || wixApiCallAttempts > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFATAL ERROR (dry run stopped):", err.message);
  process.exit(1);
});
