const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { printInvoice, getInvoices } = require("../controllers/invoice.controller");

router.get("/", auth, getInvoices);
router.get("/:id/print", auth, printInvoice);

module.exports = router;
