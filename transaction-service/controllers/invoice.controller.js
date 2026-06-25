const Invoice = require("../models/Invoice.model");
const CheckIn = require("../models/CheckIn.model");
const EntryFee = require("../models/EntryFee.model");
const path = require("path");
const fs = require("fs");

// GET /api/invoices/:id/print
const printInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate("transaction")
      .populate("createdBy", "first_name last_name email")
      .populate({ path: "elementSell", populate: { path: "customerId", select: "firstName lastName email mobileNo" } });

    if (!invoice) return res.status(404).send("Invoice not found");

    let checkIn = null;
    if (invoice.checkIn) {
      checkIn = await CheckIn.findById(invoice.checkIn).populate("customer", "name email mobileNo");
    }

    let customer = null;
    let items = null;
    if (invoice.invoiceType === "element-sell" && invoice.elementSell) {
      customer = invoice.elementSell.customerId;
      items = [{
        name: invoice.elementSell.elementName || "Element",
        description: `${invoice.elementSell.amount} ${invoice.elementSell.unit || "lb"}${invoice.elementSell.note ? " - " + invoice.elementSell.note : ""}`,
        quantity: invoice.elementSell.amount,
        price: invoice.elementSell.amount ? invoice.amount / invoice.elementSell.amount : 0,
        lineTotal: invoice.amount,
      }];
    }

    let logoDataUri = null;
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", "assets", "logo-sm1.png"));
      logoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    } catch { /* ignore */ }

    const entryFee = await EntryFee.findOne().sort({ createdAt: -1 });

    return res.render("invoice.njk", {
      invoiceDoc: invoice,
      transaction: invoice.transaction || null,
      checkIn, customer, items,
      invoicePadded: invoice.invoiceNumber ? String(invoice.invoiceNumber).padStart(7, "0") : null,
      generatedAt: new Date(),
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
      adjustedEntryFee: entryFee?.entryFee || 2.0,
    });
  } catch (err) {
    console.error("Print invoice error:", err);
    res.status(500).json({ error: "Server error rendering invoice" });
  }
};

// GET /api/invoices  — list
const getInvoices = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.invoiceType) filter.invoiceType = req.query.invoiceType;
    const [invoices, total] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate("transaction").populate("createdBy", "first_name last_name"),
      Invoice.countDocuments(filter),
    ]);
    res.json({ invoices, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { printInvoice, getInvoices };
