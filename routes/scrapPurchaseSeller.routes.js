const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createScrapPurchaseSeller,
  getScrapPurchaseSellers,
  getScrapPurchaseSellerById,
  updateScrapPurchaseSeller,
  deleteScrapPurchaseSeller,
} = require("../controllers/scrapPurchaseSeller.controller");

// Dedicated, isolated seller API for Scrap Material Purchase.
// Base path: /api/scrap-purchase-sellers (see server.js). Deliberately NOT
// nested under /api/scrap-purchase to avoid any conflict with its /:id route.
//
//   POST   /api/scrap-purchase-sellers       -> create
//   GET    /api/scrap-purchase-sellers       -> list / search
//   GET    /api/scrap-purchase-sellers/:id   -> single
//   PUT    /api/scrap-purchase-sellers/:id   -> update
//   DELETE /api/scrap-purchase-sellers/:id   -> HARD delete (seller only)
//
// All routes are auth-guarded.

router.post("/", auth, createScrapPurchaseSeller);
router.get("/", auth, getScrapPurchaseSellers);
router.get("/:id", auth, getScrapPurchaseSellerById);
router.put("/:id", auth, updateScrapPurchaseSeller);
router.delete("/:id", auth, deleteScrapPurchaseSeller);

module.exports = router;
