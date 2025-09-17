const axios = require("axios");
const CarIntake = require("../models/carInTake.model");

// @desc    Get VIN details from external API
// @route   GET /api/vin/:vinNumber
// @access  Private
const getVinDetails = async (req, res) => {
  try {
    const { vinNumber } = req.params;

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
      .populate("seller", "firstName lastName email mobileNo")
      .populate("createdBy", "first_name last_name email");

    if (existing) {
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
    const apiUrl = `https://mc-api.marketcheck.com/v2/decode/car/${vinNumber}/specs?api_key=FDVpZkQJjTxtsbKBND3bMOaEbivASsxD`;

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
    const vinDetails = response.data;

    // Upsert CarIntake by VIN: create if not exists, otherwise update vinDetails
    const carIntake = await CarIntake.findOneAndUpdate(
      { vin: vinNumber },
      { vin: vinNumber, vinDetails: vinDetails },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate("createdBy", "first_name last_name email");

    // Return VIN data + persisted CarIntake
    res.json({
      success: true,
      vinNumber: vinNumber,
      data: vinDetails,
      carIntake,
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
