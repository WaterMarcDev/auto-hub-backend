const express = require("express");
const router = express.Router();
const { syncWithWix, markInventorySynced } = require("../controllers/wix");   // added markInventorySynced by shiva
const { syncInventoriesV3 } = require("../controllers/Inventory.controller");    //added by shiva
// const { exportInventories, syncInventoriesV3 } = require("../controllers/Inventory.controller");
const { wixAuth } = require("../middleware/wixAuth");

// @route   GET /api/wix/sync
// @desc    Sync inventory with Wix (using export format)
// @access  Private (Wix authenticated)
router.get("/parts/sync", wixAuth, syncWithWix);     //added by shiva
// router.get("/parts/sync", wixAuth, exportInventories);
router.patch("/inventory-synced/:inventoryId", wixAuth, markInventorySynced);  //added by shiva

router.get("/parts/sync/v3", wixAuth, syncInventoriesV3);
module.exports = router;