const axios = require("axios");
const cron = require("node-cron");
const CarIntake = require("../models/CarIntake.model");

const SCHEDULE = process.env.VIN_CRON_SCHEDULE || "*/5 * * * *";
const BATCH_SIZE = parseInt(process.env.VIN_CRON_BATCH_SIZE || "100", 10);
const VIN_API_URL = process.env.VIN_API_URL || "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended";

const normalizeDriveType = (input) => {
  if (input == null) return undefined;
  const s = String(input).toLowerCase().trim();
  if (/(4x4|4wd|4-?wheel|four[ -]?wheel)/i.test(s)) return "4WD";
  if (/(all[ -]?wheel|awd)/i.test(s)) return "AWD";
  if (/(fwd|front[ -]?wheel)/i.test(s)) return "FWD";
  if (/(rwd|rear[ -]?wheel|2wd|2-?wheel)/i.test(s)) return "2WD";
  return undefined;
};

async function fetchVinDetailsFor(vin) {
  try {
    const res = await axios.get(`${VIN_API_URL}/${encodeURIComponent(vin)}?format=json`, { timeout: 10000 });
    return res.data?.Results?.[0] || null;
  } catch (err) {
    console.error("[VIN-CRON] fetchVinDetailsFor error for", vin, err.message);
    return null;
  }
}

function mapVinToCarDetails(vin, v) {
  return {
    vin,
    year: v?.ModelYear,
    make: v?.Make,
    model: v?.Model,
    trim: v?.Trim,
    bodyClass: v?.BodyClass,
    drive: normalizeDriveType(v?.DriveType || v?.Drive),
    fuelType: v?.FuelTypePrimary,
    engineVariant: v?.EngineModel,
    chassisNo: vin,
    engine: v?.DisplacementL,
  };
}

async function processBatch() {
  console.log(`[VIN-CRON] Starting batch (up to ${BATCH_SIZE} VINs)`);
  const query = {
    vin: { $regex: /^[A-HJ-NPR-Z0-9]{17}$/i },
    manualVinMode: { $ne: true },
    isDeleted: { $ne: true },
    $or: [{ vinDetails: { $exists: false } }, { vinDetails: null }],
  };
  const docs = await CarIntake.find(query).limit(BATCH_SIZE).lean();
  if (!docs.length) { console.log("[VIN-CRON] No VINs to fetch."); return; }

  for (const doc of docs) {
    const vin = String(doc.vin || "").trim().toUpperCase();
    if (!vin || vin.length !== 17) continue;
    const vinDetails = await fetchVinDetailsFor(vin);
    if (!vinDetails) continue;
    const mapped = mapVinToCarDetails(vin, vinDetails);
    const existing = doc.carDetails || {};
    const merged = { ...mapped };
    Object.keys(mapped).forEach(k => { if (existing[k] != null && existing[k] !== "") merged[k] = existing[k]; });
    const update = { vinDetails, carDetails: merged, vin };
    if (!doc.status || doc.status === "intake") update.status = "vin-fetched";
    try {
      await CarIntake.updateOne({ _id: doc._id }, { $set: update });
      console.log(`[VIN-CRON] Updated ${doc._id} for VIN ${vin}`);
    } catch (err) {
      console.error(`[VIN-CRON] Failed ${doc._id}:`, err.message);
    }
  }
  console.log("[VIN-CRON] Batch finished");
}

function startCron() {
  console.log(`[VIN-CRON] Scheduling: ${SCHEDULE}`);
  cron.schedule(SCHEDULE, async () => {
    try { await processBatch(); } catch (err) { console.error("[VIN-CRON] Error:", err); }
  });
  processBatch().catch(err => console.error("[VIN-CRON] Startup error:", err));
}

module.exports = { startCron, processBatch };
