/**
 * Invoice printing/rendering business logic. Extracted 1:1 from
 * controllers/invoice.controller.js during the clean-architecture
 * migration.
 *
 * NOTE: this domain reads (never writes) the Transaction and CheckIn
 * models, which are owned by other controllers/domains not part of this
 * migration batch. Those two are kept as direct Mongoose model requires
 * here (not routed through a repository) to avoid coupling this file's
 * correctness to work happening in a different batch — flagged here so a
 * later pass can point them at Transaction/CheckIn repositories once those
 * domains are migrated too. EntryFee IS routed through its repository
 * since that domain was migrated in this same batch.
 */
const invoiceRepository = require("../repositories/invoice.repository");
const entryFeeRepository = require("../repositories/entryFee.repository");
const CheckIn = require("../models/checkIn.model"); // TODO: route through a CheckIn repository once that domain is migrated
const path = require("path");
const fs = require("fs");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

async function getInvoiceForPrint(id) {
  const invoice = await invoiceRepository
    .findById(id)
    .populate("transaction")
    .populate("createdBy", "first_name last_name email")
    .populate({
      path: "elementSell",
      populate: {
        path: "customerId",
        select: "firstName lastName email mobileNo address",
      },
    });

  if (!invoice) {
    throw notFoundError("Invoice not found");
  }

  let checkIn = null;
  if (invoice.checkIn) {
    try {
      checkIn = await CheckIn.findById(invoice.checkIn).populate("customer", "name email mobileNo");
    } catch (e) {
      checkIn = null;
    }
  }

  let customer = null;
  let items = null;
  if (invoice.invoiceType === "element-sell" && invoice.elementSell) {
    customer = invoice.elementSell.customerId;
    items = [
      {
        name: `${invoice.elementSell.elementName || "Element"}`,
        description: `${invoice.elementSell.amount} ${invoice.elementSell.unit || "lb"}${
          invoice.elementSell.note ? " - " + invoice.elementSell.note : ""
        }`,
        quantity: invoice.elementSell.amount,
        price: invoice.amount / invoice.elementSell.amount || 0,
        lineTotal: invoice.amount,
      },
    ];
  }

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

  const invoicePadded = invoice.invoiceNumber ? String(invoice.invoiceNumber).padStart(7, "0") : null;

  const latestEntryFeeSetting = await entryFeeRepository.findOne().sort({ createdAt: -1 });

  return {
    invoiceDoc: invoice,
    transaction: invoice.transaction || null,
    checkIn,
    customer,
    items,
    invoicePadded,
    generatedAt: new Date(),
    logoSrc: logoDataUri || "/assets/logo-sm1.png",
    adjustedEntryFee: latestEntryFeeSetting?.entryFee || 2.0,
  };
}

module.exports = {
  getInvoiceForPrint,
};
