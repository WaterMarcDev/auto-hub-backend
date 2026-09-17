const axios = require("axios");
const cron = require("node-cron");
const CarIntake = require("../models/carIntake.model");

// Config - can be overridden via env
const SCHEDULE = process.env.VIN_CRON_SCHEDULE || "*/5 * * * *"; // every 5minutes by default to prevent warnings , updated by shiva  
const BATCH_SIZE = parseInt(process.env.VIN_CRON_BATCH_SIZE || "100", 10);
const VIN_API_URL =
  process.env.VIN_API_URL ||
  "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended";

// Reuse the drive type normalizer from vin controller logic (lightweight)
const normalizeDriveType = (input) => {
  if (input === undefined || input === null) return undefined;
  const s = String(input).toLowerCase().trim();
  if (/(^|[^a-z0-9])(4x4|4wd|4-?wheel|four[ -]?wheel)/i.test(s)) return "4WD";
  if (/(all[ -]?wheel|awd|all[ -]?wheel[ -]?drive)/i.test(s)) return "AWD";
  if (/(^|[^a-z0-9])(fwd|front[ -]?wheel|front[ -]?wheel[ -]?drive)/i.test(s))
    return "FWD";
  if (/(^|[^a-z0-9])(rwd|rear[ -]?wheel|rear[ -]?wheel[ -]?drive)/i.test(s))
    return "2WD";
  if (/(^|[^a-z0-9])(2wd|2-?wheel)/i.test(s)) return "2WD";
  return undefined;
};

async function fetchVinDetailsFor(vin) {
  try {
    const url = `${VIN_API_URL}/${encodeURIComponent(vin)}?format=json`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data && res.data.Results && res.data.Results[0]
      ? res.data.Results[0]
      : null;
  } catch (err) {
    console.error("fetchVinDetailsFor error for", vin, err.message || err);
    return null;
  }
}

function mapVinToCarDetails(vinNumber, vinDetails) {
  return {
    vin: vinNumber,
    year: vinDetails?.ModelYear || vinDetails?.model_year || undefined,
    make: vinDetails?.Make || vinDetails?.manufacturer || undefined,
    model: vinDetails?.Model || vinDetails?.model_name || undefined,
    trim: vinDetails?.Trim || undefined,
    color: vinDetails?.exterior_color || undefined,
    bodyClass: vinDetails?.BodyClass || undefined,
    drive:
      normalizeDriveType(
        vinDetails?.DriveType || vinDetails?.Drive || vinDetails?.drive
      ) || undefined,
    transmission: vinDetails?.Transmission || undefined,
    fuelType: vinDetails?.FuelTypePrimary || undefined,
    engineVariant:
      vinDetails?.EngineModel || vinDetails?.engine_code || undefined,
    chassisNo: vinNumber,
    weight: vinDetails?.GVWR || "",
    engine: vinDetails?.DisplacementL || undefined,
  };
}

async function processBatch() {
  console.log(`[VIN-CRON] Starting batch: fetch up to ${BATCH_SIZE} VINs`);

  // Find CarIntake documents that either have no vinDetails or have missing carDetails
  // Added by shiva
  const query = {
    vin: { $regex: /^[A-HJ-NPR-Z0-9]{17}$/i },
    manualVinMode: { $ne: true },
    isDeleted: { $ne: true },
    $or: [
      { vinDetails: { $exists: false } },
      { vinDetails: null },
      { carDetails: { $exists: false } },
      { $expr: { $lt: [{ $size: { $objectToArray: "$carDetails" } }, 1] } },
    ],
  };
  
  
  
  // const query = {
  //   vin: { $exists: true, $ne: null, $ne: "" },
  //   isDeleted: { $ne: true },
  //   $or: [
  //     { vinDetails: { $exists: false } },
  //     { vinDetails: null },
  //     { carDetails: { $exists: false } },
  //     { $expr: { $lt: [{ $size: { $objectToArray: "$carDetails" } }, 1] } },
  //   ],
  // };

  const docs = await CarIntake.find(query).limit(BATCH_SIZE).lean();

  if (!docs || docs.length === 0) {
    console.log("[VIN-CRON] No VINs require fetching.");
    return;
  }

  for (const doc of docs) {
    const vin = String(doc.vin || "")
      .trim()
      .toUpperCase();
    if (!vin || vin.length !== 17) {
      console.log(`[VIN-CRON] Skipping invalid VIN for doc ${doc._id}: ${vin}`);
      continue;
    }

    const vinDetails = await fetchVinDetailsFor(vin);
    if (!vinDetails) {
      console.log(`[VIN-CRON] No VIN details returned for ${vin}`);
      continue;
    }

    // Map vin details
    const mapped = mapVinToCarDetails(vin, vinDetails);

    // Merge into existing carDetails without overwriting non-empty values
    const existingDetails = doc.carDetails || {};
    const merged = { ...mapped };
    Object.keys(mapped).forEach((key) => {
      if (
        existingDetails[key] !== undefined &&
        existingDetails[key] !== null &&
        existingDetails[key] !== ""
      )
        merged[key] = existingDetails[key];
    });

    // Prepare update
    const update = {
      vinDetails: vinDetails,
      carDetails: merged,
      vin: vin,
    };

    // Try to move status if still intake
    if (!doc.status || doc.status === "intake") update.status = "vin-fetched";

    try {
      await CarIntake.updateOne({ _id: doc._id }, { $set: update });
      console.log(`[VIN-CRON] Updated doc ${doc._id} for VIN ${vin}`);
    } catch (err) {
      console.error(
        `[VIN-CRON] Failed to update ${doc._id}:`,
        err.message || err
      );
    }
  }

  console.log("[VIN-CRON] Batch finished");
}

function startCron() {
  console.log(`[VIN-CRON] Scheduling with cron expression: ${SCHEDULE}`);
  // Run on schedule
  // added by shiva: Making CRON Lightweight 
  const task = cron.schedule(SCHEDULE, async () => {
  try {
    console.log("🟢 CRON START:", new Date().toISOString());

    await processBatch();

    console.log("✅ CRON END:", new Date().toISOString());
  } catch (err) {
    console.error("❌ CRON ERROR:", err);
  }
});
// end here
  
  
  // const task = cron.schedule(SCHEDULE, () => {
  //   processBatch().catch((err) => console.error("[VIN-CRON] Batch error", err));
  // });

  // Also run once immediately on startup
  processBatch().catch((err) =>
    console.error("[VIN-CRON] Startup batch error", err)
  );

  return task;
}

module.exports = {
  startCron,
  processBatch,
};
