const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createInventory,
  getInventoryByVIN,
  getPartsMasterList,
  getAllInventories,
} = require("../controllers/Inventory.controller");

router.post("/", auth, createInventory);
router.get("/vin/:vin", auth, getInventoryByVIN);
router.get("/parts", auth, getPartsMasterList);
router.get("/", auth, getAllInventories);

module.exports = router;
