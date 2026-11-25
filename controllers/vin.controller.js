const axios = require("axios");
const { parseGVWR } = require("../utils/vehicleWeight");
const CarIntake = require("../models/CarIntake.model");
// Normalize DriveType strings to allowed enum values: ["2WD","4WD","AWD","FWD"]
const normalizeDriveType = (input) => {
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
};

// @desc    Get VIN details from external API
// @route   GET /api/vin/:vinNumber
// @access  Private
const getVinDetails = async (req, res) => {
  try {
    const vinNumber = String(req.params.vinNumber || "").trim().toUpperCase();

    // Validate VIN format (17 characters, alphanumeric except I, O, Q)
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    if (!vinRegex.test(vinNumber)) {
      return res.status(400).json({
        error:
          "Invalid VIN format. VIN must be 17 characters long and contain only valid characters.",
      });
    }

    // First check if we already have this VIN stored
    const existing = await CarIntake.findOne({ vin: vinNumber })
      .populate(
        "kyc.seller",
        "firstName lastName email mobileNo driversLicense description"
      )
      .populate("createdBy", "first_name last_name email");

    // A stored draft that never decoded (no make from NHTSA and none typed
    // in) is not treated as a valid VIN: decode it again below instead.
    const existingHasVehicle = Boolean(
      existing &&
        (String(existing.vinDetails?.Make || "").trim() ||
          String(existing.carDetails?.make || "").trim())
    );

    if (existing && (existingHasVehicle || existing.status === "payment-done")) {
      // If the existing record has completed payment, treat VIN as processed
      if (existing.status === "payment-done") {
        return res.status(400).json({ error: "VIN already processed" });
      }

      // If we already stored raw VIN details, return them; otherwise map our carDetails
      const vinData = existing.vinDetails;

      return res.json({
        success: true,
        vinNumber,
        data: vinData,
        carIntake: existing,
        source: "database",
        timestamp: new Date().toISOString(),
      });
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
      return res.status(500).json({
        error: "Invalid response from VIN API",
      });
    }

    // Persist VIN details into CarIntake (create draft or update existing by VIN)
    const vinDetails = response.data.Results?.[0];

    // NHTSA answers 200 even for VINs it cannot decode: ErrorCode is then
    // non-zero (e.g. "7"/"8" no data, "6" incomplete, "11" bad model year)
    // and Make is empty. Without a make the VIN is not a real vehicle, so it
    // is rejected and no draft is created. A VIN that decodes but only fails
    // the check digit (ErrorCode "1") is accepted with a warning, because
    // some genuine (e.g. imported) VINs do not use the check digit.
    const errorCodes = String(vinDetails?.ErrorCode ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!vinDetails || !String(vinDetails.Make || "").trim()) {
      return res.status(422).json({
        error:
          "Invalid VIN: it could not be decoded to a vehicle. Please check the VIN, or tick \"VIN is less than 17 digits\" to enter the details manually.",
        details: vinDetails?.ErrorText || undefined,
      });
    }
    const vinWarning =
      errorCodes.length && !(errorCodes.length === 1 && errorCodes[0] === "0")
        ? vinDetails.ErrorText || "The VIN was decoded with warnings."
        : undefined;

    // GVWR class text → { min, max } lbs (utils/vehicleWeight.js)

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
    let carIntake = await CarIntake.findOne({ vin: vinNumber });

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
      await carIntake.save();

      carIntake = await CarIntake.findById(carIntake._id)
        .populate(
          "kyc.seller",
          "firstName lastName email mobileNo driversLicense description"
        )
        .populate("createdBy", "first_name last_name email");
    } else {
      // Create a new CarIntake document using mapped VIN data and mark status
      carIntake = await CarIntake.create({
        vin: vinNumber,
        vinDetails,
        carDetails: mappedFromVin,
        status: "vin-fetched",
      });

      carIntake = await CarIntake.findById(carIntake._id)
        .populate(
          "kyc.seller",
          "firstName lastName email mobileNo driversLicense description"
        )
        .populate("createdBy", "first_name last_name email");
    }

    // Return VIN data + persisted CarIntake
    res.json({
      success: true,
      vinNumber: vinNumber,
      data: vinDetails,
      carIntake,
      warning: vinWarning,
      source: "MarketCheck API",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("VIN lookup error:", error.message);

    // Handle specific error types
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      return res.status(503).json({
        error: "VIN service temporarily unavailable. Please try again later.",
      });
    }

    if (error.code === "ETIMEDOUT") {
      return res.status(504).json({
        error: "VIN lookup request timed out. Please try again.",
      });
    }

    res.status(500).json({
      error: "Failed to fetch VIN details",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  getVinDetails,
};
