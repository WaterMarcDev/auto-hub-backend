const express = require("express");
const router = express.Router();
const { printInvoice } = require("../controllers/invoice.controller");
const { auth } = require("../middleware/auth");

router.use(auth);

// GET /api/invoices/:id/print
router.get("/:id/print", printInvoice);

module.exports = router;
