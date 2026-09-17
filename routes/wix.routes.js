const express = require("express");
const router = express.Router();
const { syncWithWix, markInventorySynced, listWixCollections } = require("../controllers/wix.controller");   // added markInventorySynced by shiva
const { syncInventoriesV3 } = require("../controllers/inventory.controller");    //added by shiva
// const { exportInventories, syncInventoriesV3 } = require("../controllers/inventory.controller");
const { wixAuth } = require("../middleware/wixAuth");

// NEW export controllers (appended – do not modify above)
const {
  exportAndSyncAllParts,
  exportAndSyncByMake,
  exportAndSyncByYear,
  exportAndSyncByModel,
  exportAndSyncDeduplicated,
} = require("../controllers/wix.controller");

// @route   GET /api/wix/sync
// @desc    Sync inventory with Wix (using export format)
// @access  Private (Wix authenticated)
router.get("/parts/sync", wixAuth, syncWithWix);     //added by shiva
// router.get("/parts/sync", wixAuth, exportInventories);
router.patch("/inventory-synced/:inventoryId", wixAuth, markInventorySynced);  //added by shiva

router.get("/parts/sync/v3", wixAuth, syncInventoriesV3);

// ── NEW: Export + mark-synced endpoints ──────────────────────────────────────
// @route   POST /api/wix/export/parts
// @desc    Export ALL unsynced parts to Wix format; marks each as synced
// @access  Private (Wix authenticated)
router.post("/export/parts", wixAuth, exportAndSyncAllParts);

// @route   POST /api/wix/export/parts/by-make
// @desc    Export unsynced parts grouped by Make; marks each as synced
// @access  Private (Wix authenticated)
router.post("/export/parts/by-make", wixAuth, exportAndSyncByMake);

// @route   POST /api/wix/export/parts/by-year
// @desc    Export unsynced parts grouped by Year; marks each as synced
// @access  Private (Wix authenticated)
router.post("/export/parts/by-year", wixAuth, exportAndSyncByYear);

// @route   POST /api/wix/export/parts/by-model
// @desc    Export unsynced parts grouped by Model; marks each as synced
// @access  Private (Wix authenticated)
router.post("/export/parts/by-model", wixAuth, exportAndSyncByModel);

// @route   POST /api/wix/export/parts/deduplicated
// @desc    Export unsynced parts deduplicated by SKU with quantity;
//          marks all grouped items as synced, product visible with brand
// @access  Private (Wix authenticated)
router.post("/export/parts/deduplicated", wixAuth, exportAndSyncDeduplicated);

// Get Wix Collections by shiva
router.get("/collections/list", listWixCollections);

module.exports = router;
