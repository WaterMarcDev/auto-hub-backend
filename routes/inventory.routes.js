const epxress = require("express");
const router = epxress.Router();
const { auth } = require("../middleware/auth");
const {
  createInventory,
  getInventoryByVIN,
} = require("../controllers/Inventory.controller");

router.post("/", auth, createInventory);
router.get("/vin/:vin", auth, getInventoryByVIN);

module.exports = router;
