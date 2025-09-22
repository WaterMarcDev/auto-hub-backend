const epxress = require("express");
const router = epxress.Router();
const { auth } = require("../middleware/auth");
const {
  createInventory,
  getInventoryByVIN,
  getAllInventories,
} = require("../controllers/Inventory.controller");

router.post("/", auth, createInventory);
router.get("/vin/:vin", auth, getInventoryByVIN);
router.get("/", auth, getAllInventories);

module.exports = router;
