const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { getVinDetails } = require("../controllers/vin.controller");

router.get("/:vinNumber", auth, getVinDetails);

module.exports = router;
