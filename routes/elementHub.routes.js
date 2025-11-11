const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  getAllHubItems,
  getHistory,
  sellElement,
  printInvoice,
} = require("../controllers/elementHub.controller");

// GET /api/element-hub - list hub items
router.get("/", auth, getAllHubItems);

// GET /api/element-hub/history/:id/print-invoice - print invoice for a sell transaction (must be before /history/:id)
router.get("/history/:id/print-invoice", auth, printInvoice);

// GET /api/element-hub/history and /api/element-hub/history/:id
router.get("/history", auth, getHistory);
router.get("/history/:id", auth, getHistory);

// POST /api/element-hub/sell - sell (reduce) items
router.post("/sell", auth, sellElement);

module.exports = router;
