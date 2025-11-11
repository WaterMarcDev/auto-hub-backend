const express = require("express");
const router = express.Router();
const checkInController = require("../controllers/checkIn");
const { auth } = require("../middleware/auth");

// Create check-in
router.post("/", auth, checkInController.create);

// List check-ins
router.get("/", auth, checkInController.getAll);

// Print invoice for check-in
router.get("/:id/print-invoice", auth, checkInController.printInvoice);

// Checkout a check-in
router.post("/:id/checkout", auth, checkInController.checkout);

module.exports = router;
