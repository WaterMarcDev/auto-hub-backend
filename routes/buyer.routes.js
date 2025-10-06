const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createBuyer,
  getBuyers,
  getBuyerById,
  updateBuyer,
  deleteBuyer,
} = require("../controllers/buyer.controller");

router.post("/", auth, createBuyer);
router.get("/", auth, getBuyers);
router.get("/:id", auth, getBuyerById);
router.put("/:id", auth, updateBuyer);
router.delete("/:id", auth, deleteBuyer);

module.exports = router;
