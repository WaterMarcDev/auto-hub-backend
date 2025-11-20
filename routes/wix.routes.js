const express = require("express");
const router = express.Router();
const { syncWithWix } = require("../controllers/wix");
const { wixAuth } = require("../middleware/wixAuth");

// @route   GET /api/wix/sync
// @desc    Sync inventory with Wix
// @access  Private (Wix authenticated)
router.get("/parts/sync", wixAuth, syncWithWix);
module.exports = router;
