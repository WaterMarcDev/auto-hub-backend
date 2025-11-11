const express = require("express");
const router = express.Router();
const { printInvoice } = require("../controllers/invoice.controller");

// GET /api/invoices/:id/print
router.get("/:id/print", printInvoice);

module.exports = router;
