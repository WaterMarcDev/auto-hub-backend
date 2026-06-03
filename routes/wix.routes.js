const express = require("express");
const router = express.Router();
const { syncWithWix } = require("../controllers/wix");
const { syncInventoriesV3 } = require("../controllers/Inventory.controller");    //added by shiva
// const { exportInventories, syncInventoriesV3 } = require("../controllers/Inventory.controller");
const { wixAuth } = require("../middleware/wixAuth");

// @route   GET /api/wix/sync
// @desc    Sync inventory with Wix (using export format)
// @access  Private (Wix authenticated)
router.get("/parts/sync", wixAuth, syncWithWix);     //added by shiva
// router.get("/parts/sync", wixAuth, exportInventories);
router.get("/parts/sync/v3", wixAuth, syncInventoriesV3);
module.exports = router;