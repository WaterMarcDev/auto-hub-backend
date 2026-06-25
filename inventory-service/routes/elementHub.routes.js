const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { getAllHubItems, getHistory, sellElement, addToHub, printInvoice } = require("../controllers/elementHub.controller");

router.get("/", auth, getAllHubItems);
router.post("/add", auth, addToHub);
router.post("/sell", auth, sellElement);
router.get("/:id/history", auth, getHistory);
router.get("/history/:id/print-invoice", auth, printInvoice);

module.exports = router;
