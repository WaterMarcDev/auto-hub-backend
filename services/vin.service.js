/**
 * VIN lookup business logic. Extracted 1:1 from controllers/vinController.js
 * during the clean-architecture migration — the external VIN-decode API
 * call, VIN normalization/parsing helpers, and merge logic are unchanged;
 * only CarIntake persistence now goes through carIntake.repository.js
 * instead of the model directly.
 */
const axios = require("axios");
const carIntakeRepository = require("../repositories/carIntake.repository");

// Normalize DriveType strings to allowed enum values: ["2WD","4WD","AWD","FWD"]
function normalizeDriveType(input) {
  if (input === undefined || input === null) return undefined;
  const s = String(input).toLowerCase().trim();
  // 4WD variants
  if (/(^|[^a-z0-9])(4x4|4wd|4-?wheel|four[ -]?wheel)/i.test(s)) return "4WD";
  // AWD / All-Wheel Drive
  if (/(all[ -]?wheel|awd|all[ -]?wheel[ -]?drive)/i.test(s)) return "AWD";
  // Front Wheel Drive
  if (/(^|[^a-z0-9])(fwd|front[ -]?wheel|front[ -]?wheel[ -]?drive)/i.test(s))
    return "FWD";
  // Rear / RWD treat as 2WD (enum doesn't include RWD)
  if (/(^|[^a-z0-9])(rwd|rear[ -]?wheel|rear[ -]?wheel[ -]?drive)/i.test(s))
    return "2WD";
  // Explicit 2WD
  if (/(^|[^a-z0-9])(2wd|2-?wheel)/i.test(s)) return "2WD";
  return undefined;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Helper to parse GVWR string into min/max lbs
function parseGVWR(gvwr) {
  if (!gvwr) return null;
  // Expected formats:
  // "Class 1: 6,000 lb or less (2,722 kg or less)"
  // "Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)"
  try {
    const text = String(gvwr).toLowerCase();
    // Remove commas
    const clean = text.replace(/,/g, "");

    // Extract the lb part (usually before "kg" or at the start)
    // Regex to finding numbers followed by "lb"
    // Case 1: "X - Y lb"
    const rangeMatch = clean.match(/(\d+)\s*-\s*(\d+)\s*lb/);
    if (rangeMatch) {
      return {
        min: parseInt(rangeMatch[1]),
        max: parseInt(rangeMatch[2]),
      };
    }

    // Case 2: "Y lb or less" -> 0 - Y
    const lessMatch = clean.match(/(\d+)\s*lb\s*or\s*less/);
    if (lessMatch) {
      return {
        min: 0,
        max: parseInt(lessMatch[1]),
      };
    }

    // Case 3: "Greater than Y lb" -> Y - MAX_SAFE_INTEGER
    const greaterMatch = clean.match(/greater\s*than\s*(\d+)\s*lb/);
    if (greaterMatch) {
      return {
        min: parseInt(greaterMatch[1]),
        max: Number.MAX_SAFE_INTEGER,
      };
    }

    return null;
  } catch (e) {
    console.warn("Failed to parse GVWR:", gvwr, e);
    return null;
  }
}

async function getVinDetails(vinNumber) {
  // Validate VIN format (17 characters, alphanumeric except I, O, Q)
  const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
  if (!vinRegex.test(vinNumber)) {
    throw badRequestError(
      "Invalid VIN format. VIN must be 17 characters long and contain only valid characters."
    );
  }

  // First check if we already have this VIN stored
  const existing = await carIntakeRepository
    .findOne({ vin: vinNumber })
    .populate(
      "kyc.seller",
      "firstName lastName email mobileNo driversLicense description"
    )
    .populate("createdBy", "first_name last_name email");

  if (existing) {
    // If the existing record has completed payment, treat VIN as processed
    if (existing.status === "payment-done") {
      throw badRequestError("VIN already processed");
    }

    // If we already stored raw VIN details, return them; otherwise map our carDetails
    const vinData = existing.vinDetails;

    return {
      success: true,
      vinNumber,
      data: vinData,
      carIntake: existing,
      source: "database",
      timestamp: new Date().toISOString(),
    };
  }

  // Using MarketCheck API
  // const apiUrl = `https://mc-api.marketcheck.com/v2/decode/car/${vinNumber}/specs?api_key=FDVpZkQJjTxtsbKBND3bMOaEbivASsxD`;
  const apiUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vinNumber}?format=json`;

  const response = await axios.get(apiUrl, {
    timeout: 10000, // 10 second timeout
    headers: {
      "User-Agent": "AutoHub-VIN-Decoder/1.0",
    },
  });

  if (!response.data) {
    const err = new Error("Invalid response from VIN API");
    err.statusCode = 500;
    throw err;
  }

  // Persist VIN details into CarIntake (create draft or update existing by VIN)
  const vinDetails = response.data.Results[0];

  const gvwrRange = parseGVWR(vinDetails?.GVWR);

  // Map VIN API fields to our carDetails shape (used as fallbacks)
  const mappedFromVin = {
    vin: vinNumber,
    year: vinDetails?.ModelYear || vinDetails?.model_year || undefined,
    make: vinDetails?.Make || vinDetails?.manufacturer || undefined,
    model: vinDetails?.Model || vinDetails?.model_name || undefined,
    trim: vinDetails?.Trim || undefined,
    color: vinDetails?.exterior_color || undefined,
    bodyClass: vinDetails?.BodyClass || undefined,
    drive:
      normalizeDriveType(
        vinDetails?.DriveType ||
          vinDetails?.Drive ||
          vinDetails?.drive ||
          vinDetails?.drive_type
      ) || undefined,
    transmission: vinDetails?.Transmission || undefined,
    fuelType: vinDetails?.FuelTypePrimary || undefined,
    engineVariant:
      vinDetails?.EngineModel || vinDetails?.engine_code || undefined,
    chassisNo: vinNumber,
    // weight: vinDetails?.GVWR || "", // Don't pre-fill raw GVWR string directly
    engine: vinDetails?.DisplacementL || undefined,
  };

  // Attach parsed range to vinDetails for frontend/backend validation
  if (vinDetails) {
    vinDetails.gvwrRange = vinDetails.GVWR; // persist raw string
    if (gvwrRange) {
      vinDetails.weightMin = gvwrRange.min;
      vinDetails.weightMax = gvwrRange.max;
    }
  }

  // If a CarIntake exists, merge mapped VIN values into carDetails (without
  // overwriting non-empty existing fields), persist vinDetails and merged
  // carDetails, and return the populated document. If none exists, create
  // a new CarIntake using the mapped VIN data.
  let carIntake = await carIntakeRepository.findOne({ vin: vinNumber });

  if (carIntake) {
    // Merge mapped VIN data into carIntake.carDetails without overwriting existing non-empty values
    const existingDetails = carIntake.carDetails || {};
    const merged = { ...mappedFromVin };
    Object.keys(mappedFromVin).forEach((key) => {
      if (
        existingDetails[key] !== undefined &&
        existingDetails[key] !== null &&
        existingDetails[key] !== ""
      ) {
        merged[key] = existingDetails[key];
      }
    });

    carIntake.carDetails = merged;
    carIntake.vinDetails = vinDetails;
    // Ensure top-level vin is set on the document as well
    carIntake.vin = vinNumber;
    // If this record is still in intake state, move to vin-fetched and save
    try {
      if (!carIntake.status || carIntake.status === "intake") {
        carIntake.status = "vin-fetched";
      }
    } catch (e) {
      // ignore
    }
    await carIntakeRepository.save(carIntake);

    carIntake = await carIntakeRepository
      .findById(carIntake._id)
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("createdBy", "first_name last_name email");
  } else {
    // Create a new CarIntake document using mapped VIN data and mark status
    carIntake = await carIntakeRepository.create({
      vin: vinNumber,
      vinDetails,
      carDetails: mappedFromVin,
      status: "vin-fetched",
    });

    carIntake = await carIntakeRepository
      .findById(carIntake._id)
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("createdBy", "first_name last_name email");
  }

  // Return VIN data + persisted CarIntake
  return {
    success: true,
    vinNumber: vinNumber,
    data: vinDetails,
    carIntake,
    source: "MarketCheck API",
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getVinDetails,
  normalizeDriveType,
  parseGVWR,
};
