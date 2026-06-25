const express = require("express");
const router  = express.Router();
const { auth, wixAuth } = require("../middleware/auth.middleware");
const {
  syncWithWix, markInventorySynced,
  exportAndSyncAllParts, exportAndSyncDeduplicated, exportInventoriesV3,
} = require("../controllers/wix.controller");

router.get("/sync",                           auth, syncWithWix);
router.patch("/inventory/:inventoryId/mark-synced", auth, markInventorySynced);
router.post("/export/parts",                  auth, exportAndSyncAllParts);
router.post("/export/parts/deduplicated",     auth, exportAndSyncDeduplicated);
router.post("/export/v3",                     auth, exportInventoriesV3);

module.exports = router;
