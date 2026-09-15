const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createScrapPurchase,
  getScrapPurchases,
  getScrapPurchaseById,
  updateScrapPurchase,
  deleteScrapPurchase,
  printScrapPurchase,
} = require("../controllers/scrapPurchase.controller");

// GET /api/scrap-purchase/:id/print — printable bill (must be declared before
// the generic /:id route so "print" is not interpreted as an id).
router.get("/:id/print", auth, printScrapPurchase);

// CRUD
router.post("/", auth, createScrapPurchase);
router.get("/", auth, getScrapPurchases);
router.get("/:id", auth, getScrapPurchaseById);
router.put("/:id", auth, updateScrapPurchase);
router.delete("/:id", auth, deleteScrapPurchase);

module.exports = router;
