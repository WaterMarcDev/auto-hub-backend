const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createInventory,
  getInventoryByVIN,
  getPartsMasterList,
  getAllInventories,
  exportInventories,
} = require("../controllers/Inventory.controller");

router.post("/", auth, createInventory);
router.get("/export", auth, exportInventories); // Specific routes before generic /:id or / (if any conflict)
router.get("/vin/:vin", auth, getInventoryByVIN);
router.get("/parts", auth, getPartsMasterList);
router.get("/", auth, getAllInventories);

module.exports = router;
