/**
 * Car Intake vehicle weight check.
 *
 * vin.controller.js turns the NHTSA GVWR class into vinDetails.weightMin /
 * weightMax (e.g. "Class 1C: 4,001 - 5,000 lb" → 4001 / 5000). GVWR is the
 * MAXIMUM loaded weight of the vehicle, not what the car weighs, so a car's
 * real (curb) weight is normally BELOW the class minimum. The weight is
 * therefore only checked against the class maximum: it must be more than 0
 * and not above the GVWR. The minimum is ignored.
 *
 * Open-ended classes ("greater than 33,000 lb") are stored with
 * Number.MAX_SAFE_INTEGER as max and have no upper limit.
 */
function vehicleWeightMax(vinDetails) {
  const max = Number(vinDetails?.weightMax);
  return Number.isFinite(max) && max > 0 && max < Number.MAX_SAFE_INTEGER ? max : null;
}

// Throws when the weight is not allowed; returns nothing otherwise.
function assertVehicleWeight(weight, vinDetails) {
  if (!Number.isFinite(weight)) return;
  if (weight <= 0) {
    throw new Error("Weight must be greater than 0 lbs.");
  }
  const max = vehicleWeightMax(vinDetails);
  if (max !== null && weight > max) {
    throw new Error(
      `Weight ${weight} lbs is above the maximum (GVWR) for this vehicle class (${max} lbs).`
    );
  }
}

/**
 * Parses an NHTSA GVWR class string into { min, max } lbs:
 *   "Class 1: 6,000 lb or less (2,722 kg or less)"  → { min: 0, max: 6000 }
 *   "Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)" → { min: 6001, max: 7000 }
 *   "Class 8: 33,001 lb and above" / "greater than 33,000 lb"
 *                                                   → { min: 33001, max: MAX_SAFE_INTEGER }
 * Returns null when the text has no usable range.
 */
function parseGVWR(gvwr) {
  if (!gvwr) return null;
  try {
    const clean = String(gvwr).toLowerCase().replace(/,/g, "");

    const rangeMatch = clean.match(/(\d+)\s*-\s*(\d+)\s*lb/);
    if (rangeMatch) return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };

    const lessMatch = clean.match(/(\d+)\s*lb\s*or\s*less/);
    if (lessMatch) return { min: 0, max: parseInt(lessMatch[1], 10) };

    const greaterMatch =
      clean.match(/greater\s*than\s*(\d+)\s*lb/) || clean.match(/(\d+)\s*lb\s*and\s*above/);
    if (greaterMatch) return { min: parseInt(greaterMatch[1], 10), max: Number.MAX_SAFE_INTEGER };

    return null;
  } catch (e) {
    console.warn("Failed to parse GVWR:", gvwr, e);
    return null;
  }
}

// Every weight in the CRM allows at most 2 decimal places. Returns an error
// message when `value` has more, otherwise null (blank / non-numeric values
// are left to the other checks).
const MAX_WEIGHT_DECIMALS = 2;
function weightDecimalsError(value, label = "Weight") {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  const match = text.match(/^\d*\.(\d+)$/);
  if (match && match[1].length > MAX_WEIGHT_DECIMALS) {
    return `${label} can have at most ${MAX_WEIGHT_DECIMALS} decimal places`;
  }
  return null;
}

// Every weight in the CRM is at most this many lbs (same as the inventory
// weight limit, utils/inventoryFieldRules.js). Returns an error message for a
// bigger number, otherwise null (blank / non-numeric left to other checks).
const MAX_CRM_WEIGHT_LBS = 15000;
function weightLimitError(value, label = "Weight") {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(String(value).trim());
  if (Number.isFinite(n) && n > MAX_CRM_WEIGHT_LBS) {
    return `${label} can be at most ${MAX_CRM_WEIGHT_LBS.toLocaleString("en-US")} lbs`;
  }
  return null;
}

module.exports = {
  vehicleWeightMax,
  assertVehicleWeight,
  parseGVWR,
  MAX_WEIGHT_DECIMALS,
  weightDecimalsError,
  MAX_CRM_WEIGHT_LBS,
  weightLimitError,
};
