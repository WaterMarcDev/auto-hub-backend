const ElementHub = require("../models/elementHub.model");
const ElementHubHistory = require("../models/elementHubHistory.model");
const Element = require("../models/elements.model");
const Transaction = require("../models/Transaction");
const Invoice = require("../models/Invoice");
const fs = require("fs");
const path = require("path");

// Get all hub items (simple list)
const getAllHubItems = async (req, res) => {
  try {
    const items = await ElementHub.find({ isDeleted: { $ne: true } }).sort({
      elementName: 1,
    });
    res.status(200).json(items);
  } catch (error) {
    console.error("Error fetching element hub items:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get history for an elementHub or by elementName
const getHistory = async (req, res) => {
  try {
    const { id } = req.params; // can be hubId
    const filter = {};
    if (id) filter.elementHubId = id;
    if (req.query.elementName) {
      filter.elementName = req.query.elementName;
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }

    const history = await ElementHubHistory.find(filter)
      .populate("customerId", "firstName lastName mobileNo email")
      .populate("invoiceId")
      .populate("transactionId")
      .sort({
        createdAt: -1,
      });
    res.status(200).json(history);
  } catch (error) {
    console.error("Error fetching hub history:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Sell (reduce) from hub
const sellElement = async (req, res) => {
  try {
    const { elementName, amount, unit, note, createdBy, customerId } = req.body;
    if (!elementName || amount == null) {
      return res
        .status(400)
        .json({ message: "elementName and amount required" });
    }

    if (!customerId) {
      return res
        .status(400)
        .json({ message: "customerId (buyer) is required for sells" });
    }

    const name = String(elementName).trim();
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) {
      return res
        .status(400)
        .json({ message: "amount must be a positive number" });
    }

    // Atomically decrement hub total if sufficient quantity exists
    const updatedHub = await ElementHub.findOneAndUpdate(
      { elementName: name, totalWeight: { $gte: amt } },
      { $inc: { totalWeight: -amt } },
      { new: true }
    );

    if (!updatedHub) {
      return res.status(400).json({ message: "Insufficient quantity in hub" });
    }

    // Create history record for the sell
    const history = await ElementHubHistory.create({
      elementHubId: updatedHub._id,
      elementName: updatedHub.elementName,
      elementId: updatedHub.elementId,
      type: "sell",
      amount: amt,
      unit: unit || updatedHub.unit,
      customerId,
      note,
      createdBy: req.user ? req.user._id : createdBy,
    });

    // Optionally create a Transaction and persist an Invoice for this sell
    // Accept monetary sale value and payment details in the request body
    const saleValue =
      req.body.saleValue != null ? Number(req.body.saleValue) : 0;
    const taxRate =
      req.body.taxRate != null ? Number(req.body.taxRate) : 0.06625;
    const taxAmount =
      req.body.taxAmount != null
        ? Number(req.body.taxAmount)
        : Number((saleValue * taxRate).toFixed(2));
    const totalAmount =
      req.body.totalAmount != null
        ? Number(req.body.totalAmount)
        : Number((saleValue + taxAmount).toFixed(2));
    const paymentMethod = req.body.paymentMethod || undefined;

    let transactionDoc = null;
    let invoiceDoc = null;
    try {
      transactionDoc = await new Transaction({
        type: "credit",
        amount: saleValue,
        taxRate: taxRate,
        taxAmount: taxAmount,
        netAmount: totalAmount,
        paymentMethod,
        description:
          note ||
          `Sale of ${amt} ${unit || updatedHub.unit} ${updatedHub.elementName}`,
        status: "completed",
        createdBy: req.user ? req.user._id : createdBy,
      }).save();

      // Create Invoice record linked to this transaction and the element-sell history
      invoiceDoc = await Invoice.createFrom({
        checkInId: undefined,
        transactionId: transactionDoc._id,
        snapshot: {
          amount: saleValue,
          taxRate: taxRate,
          taxAmount: taxAmount,
          total: totalAmount,
          paymentMethod,
          invoiceDate: new Date(),
        },
        createdBy: req.user ? req.user._id : createdBy,
        elementSellId: history._id,
        invoiceType: "element-sell",
      });

      // Update history record with invoice ID
      if (invoiceDoc && invoiceDoc._id) {
        await ElementHubHistory.findByIdAndUpdate(history._id, {
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

    res.status(200).json({
      hub: updatedHub,
      history,
      transaction: transactionDoc,
      invoice: invoiceDoc,
    });
  } catch (error) {
    console.error("Error selling element:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Internal helper to add amount (used by scrap element creation)
const addToHubInternal = async ({
  elementName,
  elementId,
  amount,
  unit,
  sourceVin,
  createdBy,
}) => {
  if (!elementName || amount == null) return null;
  const name = String(elementName).trim();
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return null;

  const unitVal = unit || "lb";

  // Upsert hub document
  const hub = await ElementHub.findOneAndUpdate(
    { elementName: name },
    {
      $setOnInsert: { elementId: elementId, unit: unitVal },
      $inc: { totalWeight: amt },
    },
    { new: true, upsert: true }
  );

  // Create history
  await ElementHubHistory.create({
    elementHubId: hub._id,
    elementId: elementId,
    elementName: hub.elementName,
    type: "add",
    amount: amt,
    unit: unitVal,
    sourceVin,
    createdBy,
  });

  return hub;
};

// Print invoice for an element sell transaction
// @route   GET /api/element-hub/history/:id/print-invoice
// @access  Private
const printInvoice = async (req, res) => {
  try {
    const historyId = req.params.id;

    // Find the history record
    const history = await ElementHubHistory.findById(historyId)
      .populate("customerId", "firstName lastName mobileNo email address")
      .populate("elementId", "name")
      .populate("transactionId")
      .populate("createdBy", "first_name last_name email");

    if (!history) {
      return res.status(404).send("Transaction history not found");
    }

    if (history.type !== "sell") {
      return res.status(400).send("Only sell transactions can have invoices");
    }

    // Determine the user to use as creator (fallback if no req.user or history.createdBy)
    const creatorId =
      req.user?._id || history.createdBy?._id || history.createdBy;

    // Check if invoice already exists
    let invoiceDoc = null;
    if (history.invoiceId) {
      invoiceDoc = await Invoice.findById(history.invoiceId)
        .populate("transaction")
        .populate("createdBy", "first_name last_name email");
    }

    // If no invoice exists, create one now
    if (!invoiceDoc) {
      // We need transaction data - check if there's a transaction linked in history
      let transactionDoc = history.transactionId || null;

      // If no transaction in history, try to find one
      if (!transactionDoc) {
        const existingTransaction = await Transaction.findOne({
          description: { $regex: history.elementName, $options: "i" },
          createdAt: {
            $gte: new Date(history.createdAt.getTime() - 1000), // within 1 second
            $lte: new Date(history.createdAt.getTime() + 1000),
          },
        });

        if (existingTransaction) {
          transactionDoc = existingTransaction;
        } else {
          // Create a new transaction if none exists
          transactionDoc = await new Transaction({
            type: "credit",
            amount: 0, // Default if no sale value was recorded
            paymentMethod: "cash",
            description: `Sale of ${history.amount} ${history.unit || "lb"} ${
              history.elementName
            }`,
            status: "completed",
            createdBy: creatorId,
          }).save();

          // Update history with transaction ID
          await ElementHubHistory.findByIdAndUpdate(history._id, {
            transactionId: transactionDoc._id,
          });
        }
      }

      // Create invoice
      invoiceDoc = await Invoice.createFrom({
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

      // Update history with invoice ID
      await ElementHubHistory.findByIdAndUpdate(history._id, {
        invoiceId: invoiceDoc._id,
      });

      // Re-fetch with population
      invoiceDoc = await Invoice.findById(invoiceDoc._id)
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

    // Compute padded invoice number
    const invoicePadded = invoiceDoc.invoiceNumber
      ? String(invoiceDoc.invoiceNumber).padStart(7, "0")
      : null;

    // Prepare data for template
    const data = {
      invoiceDoc,
      invoicePadded,
      customer: history.customerId,
      transaction: invoiceDoc.transaction || history.transactionId,
      elementSell: history,
      generatedAt: new Date(),
      generatedBy: req.user
        ? { id: req.user._id, name: req.user.first_name || req.user.name || "" }
        : null,
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
    };

    // Render invoice template
    return res.render("invoice.njk", data);
  } catch (err) {
    console.error("Print element sell invoice error:", err);
    return res.status(500).json({ error: "Server error rendering invoice" });
  }
};

module.exports = {
  getAllHubItems,
  getHistory,
  sellElement,
  printInvoice,
  addToHubInternal,
};
