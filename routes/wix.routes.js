const express = require("express");
const router = express.Router();
// const { syncWithWix } = require("../controllers/wix");
const { exportInventories } = require("../controllers/Inventory.controller");
const { wixAuth } = require("../middleware/wixAuth");

// @route   GET /api/wix/sync
// @desc    Sync inventory with Wix (using export format)
// @access  Private (Wix authenticated)
// router.get("/parts/sync", wixAuth, syncWithWix);
router.get("/parts/sync", wixAuth, exportInventories);
module.exports = router;
