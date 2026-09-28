const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { getVinDetails } = require("../controllers/vin.controller");

// @route   GET /api/vin/:vinNumber
// @desc    Get VIN details by VIN number (URL parameter)
// @access  Private
router.get("/:vinNumber", auth, getVinDetails);

module.exports = router;
