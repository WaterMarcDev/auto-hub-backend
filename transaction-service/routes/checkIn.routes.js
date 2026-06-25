const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { create, getAll, checkout, printInvoice } = require("../controllers/checkIn.controller");

router.post("/", auth, create);
router.get("/", auth, getAll);
router.patch("/:id/checkout", auth, checkout);
router.get("/:id/print-invoice", auth, printInvoice);

module.exports = router;
