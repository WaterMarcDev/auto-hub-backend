/**
 * Element Hub business logic. Extracted 1:1 from
 * controllers/elementHub.controller.js during the clean-architecture
 * migration — every atomic hub-quantity update, transaction/invoice
 * side-effect, and the print-invoice data assembly are preserved exactly.
 *
 * NOTE: `addToHubInternal` is called directly by
 * services/scrapElement.service.js via controllers/elementHub.controller.js
 * (a pre-existing controller-to-controller dependency) — that function's
 * name, parameters, and return shape are preserved exactly here and
 * re-exported unchanged from the controller.
 */
const fs = require("fs");
const path = require("path");
const elementHubRepository = require("../repositories/elementHub.repository");
const elementHubHistoryRepository = require("../repositories/elementHubHistory.repository");
const transactionRepository = require("../repositories/transaction.repository");
const invoiceRepository = require("../repositories/invoice.repository");

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getAllHubItems() {
  return elementHubRepository.find({ isDeleted: { $ne: true } }).sort({ elementName: 1 });
}

async function getHistory(id, query) {
  const filter = {};
  if (id) filter.elementHubId = id;
  if (query.elementName) filter.elementName = query.elementName;
  if (query.type) filter.type = query.type;

  return elementHubHistoryRepository
    .find(filter)
    .populate("customerId", "firstName lastName mobileNo email")
    .populate("invoiceId")
    .populate("transactionId")
    .sort({ createdAt: -1 });
}

async function sellElement(body, user) {
  const { elementName, amount, unit, note, createdBy, customerId } = body;
  if (!elementName || amount == null) {
    throw validationError("elementName and amount required");
  }

  if (!customerId) {
    throw validationError("customerId (buyer) is required for sells");
  }

  const name = String(elementName).trim();
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    throw validationError("amount must be a positive number");
  }

  // Atomically decrement hub total if sufficient quantity exists
  const updatedHub = await elementHubRepository.findOneAndUpdate(
    { elementName: name, totalWeight: { $gte: amt } },
    { $inc: { totalWeight: -amt } },
    { new: true }
  );

  if (!updatedHub) {
    throw validationError("Insufficient quantity in hub");
  }

  // Create history record for the sell
  const history = await elementHubHistoryRepository.create({
    elementHubId: updatedHub._id,
    elementName: updatedHub.elementName,
    elementId: updatedHub.elementId,
    type: "sell",
    amount: amt,
    unit: unit || updatedHub.unit,
    customerId,
    note,
    createdBy: user ? user._id : createdBy,
  });

  // Optionally create a Transaction and persist an Invoice for this sell
  const saleValue = body.saleValue != null ? Number(body.saleValue) : 0;
  const taxRate = body.taxRate != null ? Number(body.taxRate) : 0.06625;
  const taxAmount = body.taxAmount != null ? Number(body.taxAmount) : Number((saleValue * taxRate).toFixed(2));
  const totalAmount = body.totalAmount != null ? Number(body.totalAmount) : Number((saleValue + taxAmount).toFixed(2));
  const paymentMethod = body.paymentMethod || undefined;

  let transactionDoc = null;
  let invoiceDoc = null;
  try {
    transactionDoc = await transactionRepository.build({
      type: "credit",
      amount: saleValue,
      taxRate,
      taxAmount,
      netAmount: totalAmount,
      paymentMethod,
      description: note || `Sale of ${amt} ${unit || updatedHub.unit} ${updatedHub.elementName}`,
      status: "completed",
      createdBy: user ? user._id : createdBy,
    }).save();

    invoiceDoc = await invoiceRepository.createFrom({
      checkInId: undefined,
      transactionId: transactionDoc._id,
      snapshot: {
        amount: saleValue,
        taxRate,
        taxAmount,
        total: totalAmount,
        paymentMethod,
        invoiceDate: new Date(),
      },
      createdBy: user ? user._id : createdBy,
      elementSellId: history._id,
      invoiceType: "element-sell",
    });

    if (invoiceDoc && invoiceDoc._id) {
      await elementHubHistoryRepository.findByIdAndUpdate(history._id, {
        invoiceId: invoiceDoc._id,
        transactionId: transactionDoc._id,
      });
      history.invoiceId = invoiceDoc._id;
      history.transactionId = transactionDoc._id;
    }
  } catch (e) {
    // Log but do not rollback hub decrement — application can implement compensation later
    console.error("Error creating transaction/invoice for sell:", e);
  }

  return { hub: updatedHub, history, transaction: transactionDoc, invoice: invoiceDoc };
}

// Internal helper to add amount (used by scrap element creation)
async function addToHubInternal({ elementName, elementId, amount, unit, sourceVin, createdBy }) {
  if (!elementName || amount == null) return null;
  const name = String(elementName).trim();
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return null;

  const unitVal = unit || "lb";

  const hub = await elementHubRepository.findOneAndUpdate(
    { elementName: name },
    { $setOnInsert: { elementId, unit: unitVal }, $inc: { totalWeight: amt } },
    { new: true, upsert: true }
  );

  await elementHubHistoryRepository.create({
    elementHubId: hub._id,
    elementId,
    elementName: hub.elementName,
    type: "add",
    amount: amt,
    unit: unitVal,
    sourceVin,
    createdBy,
  });

  return hub;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  err.plainText = true;
  return err;
}

function badRequestTextError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.plainText = true;
  return err;
}

/**
 * Prepares all data needed to render the element-sell invoice template.
 * Rendering itself (res.render) stays in the controller — that's a
 * response-formatting/HTTP concern, not business logic.
 */
async function buildPrintInvoiceData(historyId, reqUser) {
  const history = await elementHubHistoryRepository
    .findById(historyId)
    .populate("customerId", "firstName lastName mobileNo email address")
    .populate("elementId", "name")
    .populate("transactionId")
    .populate("createdBy", "first_name last_name email");

  if (!history) {
    throw notFoundError("Transaction history not found");
  }

  if (history.type !== "sell") {
    throw badRequestTextError("Only sell transactions can have invoices");
  }

  const creatorId = reqUser?._id || history.createdBy?._id || history.createdBy;

  let invoiceDoc = null;
  if (history.invoiceId) {
    invoiceDoc = await invoiceRepository
      .findById(history.invoiceId)
      .populate("transaction")
      .populate("createdBy", "first_name last_name email");
  }

  if (!invoiceDoc) {
    let transactionDoc = history.transactionId || null;

    if (!transactionDoc) {
      const existingTransaction = await transactionRepository.findOne({
        description: { $regex: history.elementName, $options: "i" },
        createdAt: {
          $gte: new Date(history.createdAt.getTime() - 1000), // within 1 second
          $lte: new Date(history.createdAt.getTime() + 1000),
        },
      });

      if (existingTransaction) {
        transactionDoc = existingTransaction;
      } else {
        transactionDoc = await transactionRepository
          .build({
            type: "credit",
            amount: 0, // Default if no sale value was recorded
            paymentMethod: "cash",
            description: `Sale of ${history.amount} ${history.unit || "lb"} ${history.elementName}`,
            status: "completed",
            createdBy: creatorId,
          })
          .save();

        await elementHubHistoryRepository.findByIdAndUpdate(history._id, {
          transactionId: transactionDoc._id,
        });
      }
    }

    invoiceDoc = await invoiceRepository.createFrom({
      checkInId: undefined,
      transactionId: transactionDoc._id,
      snapshot: {
        amount: transactionDoc.amount,
        paymentMethod: transactionDoc.paymentMethod,
        invoiceDate: history.createdAt || new Date(),
      },
      createdBy: creatorId,
      elementSellId: history._id,
      invoiceType: "element-sell",
    });

    await elementHubHistoryRepository.findByIdAndUpdate(history._id, {
      invoiceId: invoiceDoc._id,
    });

    invoiceDoc = await invoiceRepository
      .findById(invoiceDoc._id)
      .populate("transaction")
      .populate("createdBy", "first_name last_name email");
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
    console.warn("Could not read logo for invoice:", e && e.message);
    logoDataUri = null;
  }

  const invoicePadded = invoiceDoc.invoiceNumber ? String(invoiceDoc.invoiceNumber).padStart(7, "0") : null;

  return {
    invoiceDoc,
    invoicePadded,
    customer: history.customerId,
    transaction: invoiceDoc.transaction || history.transactionId,
    elementSell: history,
    generatedAt: new Date(),
    generatedBy: reqUser ? { id: reqUser._id, name: reqUser.first_name || reqUser.name || "" } : null,
    logoSrc: logoDataUri || "/assets/logo-sm1.png",
  };
}

module.exports = {
  getAllHubItems,
  getHistory,
  sellElement,
  addToHubInternal,
  buildPrintInvoiceData,
};
