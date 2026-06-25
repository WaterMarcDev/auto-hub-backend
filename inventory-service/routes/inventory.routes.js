const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const {
  createInventory, getAllInventories, getInventoryByVIN,
  getPartsMasterList, exportInventories, deduplicateInventory, softDeleteInventory,
} = require("../controllers/inventory.controller");

router.get("/parts", auth, getPartsMasterList);
router.get("/export", auth, exportInventories);
router.get("/vin/:vin", auth, getInventoryByVIN);
router.post("/deduplicate", auth, deduplicateInventory);
router.post("/", auth, createInventory);
router.get("/", auth, getAllInventories);
router.delete("/:id", auth, softDeleteInventory);

module.exports = router;
