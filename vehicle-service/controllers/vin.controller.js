const axios = require("axios");
const CarIntake = require("../models/CarIntake.model");

const normalizeDriveType = (input) => {
  if (input == null) return undefined;
  const s = String(input).toLowerCase().trim();
  if (/(4x4|4wd|4-?wheel|four[ -]?wheel)/i.test(s)) return "4WD";
  if (/(all[ -]?wheel|awd)/i.test(s)) return "AWD";
  if (/(fwd|front[ -]?wheel)/i.test(s)) return "FWD";
  if (/(rwd|rear[ -]?wheel|2wd|2-?wheel)/i.test(s)) return "2WD";
  return undefined;
};

const parseGVWR = (gvwr) => {
  if (!gvwr) return null;
  try {
    const clean = String(gvwr).toLowerCase().replace(/,/g, "");
    const rangeMatch = clean.match(/(\d+)\s*-\s*(\d+)\s*lb/);
    if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
    const lessMatch = clean.match(/(\d+)\s*lb\s*or\s*less/);
    if (lessMatch) return { min: 0, max: parseInt(lessMatch[1]) };
    const greaterMatch = clean.match(/greater\s*than\s*(\d+)\s*lb/);
    if (greaterMatch) return { min: parseInt(greaterMatch[1]), max: Number.MAX_SAFE_INTEGER };
    return null;
  } catch (e) {
    return null;
  }
};

// GET /api/vin/:vinNumber
const getVinDetails = async (req, res) => {
  try {
    const { vinNumber } = req.params;
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    if (!vinRegex.test(vinNumber)) {
      return res.status(400).json({ error: "Invalid VIN format. Must be 17 valid characters." });
    }

    const existing = await CarIntake.findOne({ vin: vinNumber })
      .populate("kyc.seller", "firstName lastName email mobileNo driversLicense description")
      .populate("createdBy", "first_name last_name email");

    if (existing) {
      if (existing.status === "payment-done") {
        return res.status(400).json({ error: "VIN already processed" });
      }
      return res.json({
        success: true, vinNumber, data: existing.vinDetails,
        carIntake: existing, source: "database", timestamp: new Date().toISOString(),
      });
    }

    const apiUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vinNumber}?format=json`;
    const response = await axios.get(apiUrl, {
      timeout: 10000,
      headers: { "User-Agent": "AutoHub-VIN-Decoder/1.0" },
    });

    if (!response.data) return res.status(500).json({ error: "Invalid response from VIN API" });

    const vinDetails = response.data.Results[0];
    const gvwrRange = parseGVWR(vinDetails?.GVWR);
    if (vinDetails && gvwrRange) {
      vinDetails.weightMin = gvwrRange.min;
      vinDetails.weightMax = gvwrRange.max;
    }

    const mappedFromVin = {
      vin: vinNumber,
      year: vinDetails?.ModelYear,
      make: vinDetails?.Make,
      model: vinDetails?.Model,
      trim: vinDetails?.Trim,
      bodyClass: vinDetails?.BodyClass,
      drive: normalizeDriveType(vinDetails?.DriveType || vinDetails?.Drive),
      fuelType: vinDetails?.FuelTypePrimary,
      engineVariant: vinDetails?.EngineModel,
      chassisNo: vinNumber,
      engine: vinDetails?.DisplacementL,
    };

    let carIntake = await CarIntake.findOne({ vin: vinNumber });
    if (carIntake) {
      const existing = carIntake.carDetails || {};
      const merged = { ...mappedFromVin };
      Object.keys(mappedFromVin).forEach((key) => {
        if (existing[key] != null && existing[key] !== "") merged[key] = existing[key];
      });
      carIntake.carDetails = merged;
      carIntake.vinDetails = vinDetails;
      carIntake.vin = vinNumber;
      if (!carIntake.status || carIntake.status === "intake") carIntake.status = "vin-fetched";
      await carIntake.save();
    } else {
      carIntake = await CarIntake.create({ vin: vinNumber, vinDetails, carDetails: mappedFromVin, status: "vin-fetched" });
    }

    carIntake = await CarIntake.findById(carIntake._id)
      .populate("kyc.seller", "firstName lastName email mobileNo driversLicense description")
      .populate("createdBy", "first_name last_name email");

    res.json({ success: true, vinNumber, data: vinDetails, carIntake, source: "NHTSA API", timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("VIN lookup error:", error.message);
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      return res.status(503).json({ error: "VIN service temporarily unavailable." });
    }
    if (error.code === "ETIMEDOUT") return res.status(504).json({ error: "VIN lookup request timed out." });
    res.status(500).json({ error: "Failed to fetch VIN details", details: process.env.NODE_ENV === "development" ? error.message : undefined });
  }
};

module.exports = { getVinDetails };
