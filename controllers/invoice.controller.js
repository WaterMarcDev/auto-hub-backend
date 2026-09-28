const Invoice = require("../models/Invoice.model");
const Transaction = require("../models/Transaction.model");
const CheckIn = require("../models/CheckIn.model");
const EntryFee = require("../models/EntryFee.model");
const path = require("path");
const fs = require("fs");

const printInvoice = async (req, res) => {
  try {
    const id = req.params.id;
    const invoice = await Invoice.findById(id)
      .populate("transaction")
      .populate("createdBy", "first_name last_name email")
      .populate({
        path: "elementSell",
        populate: {
          path: "customerId",
          select: "firstName lastName email mobileNo address",
        },
      });

    if (!invoice) return res.status(404).send("Invoice not found");

    // load optional checkin if present
    let checkIn = null;
    if (invoice.checkIn) {
      try {
        checkIn = await CheckIn.findById(invoice.checkIn).populate(
          "customer",
          "name email mobileNo"
        );
      } catch (e) {
        checkIn = null;
      }
    }

    // For element-sell invoices, extract customer from elementSell
    let customer = null;
    let items = null;
    if (invoice.invoiceType === "element-sell" && invoice.elementSell) {
      customer = invoice.elementSell.customerId;
      // Build items array for element sell
      items = [
        {
          name: `${invoice.elementSell.elementName || "Element"}`,
          description: `${invoice.elementSell.amount} ${
            invoice.elementSell.unit || "lb"
          }${invoice.elementSell.note ? " - " + invoice.elementSell.note : ""}`,
          quantity: invoice.elementSell.amount,
          price: invoice.amount / invoice.elementSell.amount || 0,
          lineTotal: invoice.amount,
        },
      ];
    }

    // Load logo as base64 data URI
    let logoDataUri = null;
    try {
      const logoPath = path.join(__dirname, "..", "assets", "logo-sm1.png");
      if (fs.existsSync(logoPath)) {
        const buf = fs.readFileSync(logoPath);
        const b64 = buf.toString("base64");
        logoDataUri = `data:image/png;base64,${b64}`;
      }
    } catch (e) {
      logoDataUri = null;
    }

    const invoicePadded = invoice.invoiceNumber
      ? String(invoice.invoiceNumber).padStart(7, "0")
      : null;

    return res.render("invoice.njk", {
      invoiceDoc: invoice,
      transaction: invoice.transaction || null,
      checkIn,
      customer,
      items,
      invoicePadded,
      generatedAt: new Date(),
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
      adjustedEntryFee: (await EntryFee.findOne().sort({ createdAt: -1 }))?.entryFee || 2.0,
    });
  } catch (err) {
    console.error("Print invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};

module.exports = { printInvoice };
