const ElementHub = require("../models/ElementHub.model");
const ElementHubHistory = require("../models/ElementHubHistory.model");
const Transaction = require("../models/Transaction.model");
const Invoice = require("../models/Invoice.model");
const path = require("path");
const fs = require("fs");

// GET /api/element-hub
const getAllHubItems = async (req, res) => {
  try {
    const items = await ElementHub.find({ isDeleted: { $ne: true } }).sort({ elementName: 1 });
    res.status(200).json(items);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/element-hub/:id/history
const getHistory = async (req, res) => {
  try {
    const filter = {};
    if (req.params.id) filter.elementHubId = req.params.id;
    if (req.query.elementName) filter.elementName = req.query.elementName;
    if (req.query.type) filter.type = req.query.type;

    const history = await ElementHubHistory.find(filter)
      .populate("customerId", "firstName lastName mobileNo email")
      .populate("invoiceId")
      .populate("transactionId")
      .sort({ createdAt: -1 });
    res.status(200).json(history);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/element-hub/sell
const sellElement = async (req, res) => {
  try {
    const { elementName, amount, unit, note, customerId, saleValue, taxRate, paymentMethod } = req.body;

    if (!elementName || amount == null) return res.status(400).json({ message: "elementName and amount are required" });
    if (!customerId) return res.status(400).json({ message: "customerId is required for sells" });

    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "amount must be a positive number" });

    const updatedHub = await ElementHub.findOneAndUpdate(
      { elementName: String(elementName).trim(), totalWeight: { $gte: amt } },
      { $inc: { totalWeight: -amt } },
      { new: true }
    );
    if (!updatedHub) return res.status(400).json({ message: "Insufficient quantity in hub" });

    const history = await ElementHubHistory.create({
      elementHubId: updatedHub._id,
      elementName: updatedHub.elementName,
      elementId: updatedHub.elementId,
      type: "sell",
      amount: amt,
      unit: unit || updatedHub.unit,
      customerId,
      note,
      createdBy: req.user?._id,
    });

    const sale = Number(saleValue ?? 0);
    const rate = Number(taxRate ?? 0.06625);
    const tax = Number((sale * rate).toFixed(2));
    const total = Number((sale + tax).toFixed(2));

    let transactionDoc = null;
    let invoiceDoc = null;
    try {
      transactionDoc = await new Transaction({
        type: "credit", amount: sale, taxRate: rate, taxAmount: tax, netAmount: total,
        paymentMethod, description: note || `Sale of ${amt} ${unit || updatedHub.unit} ${updatedHub.elementName}`,
        status: "completed", createdBy: req.user?._id,
      }).save();

      invoiceDoc = await Invoice.createFrom({
        transactionId: transactionDoc._id,
        snapshot: { amount: sale, taxRate: rate, taxAmount: tax, total, paymentMethod, invoiceDate: new Date() },
        createdBy: req.user?._id,
        elementSellId: history._id,
        invoiceType: "element-sell",
      });

      await ElementHubHistory.findByIdAndUpdate(history._id, {
        invoiceId: invoiceDoc._id, transactionId: transactionDoc._id,
      });
    } catch (e) {
      console.error("Error creating transaction/invoice for sell:", e.message);
    }

    res.status(200).json({ hub: updatedHub, history, transaction: transactionDoc, invoice: invoiceDoc });
  } catch (error) {
    console.error("Sell element error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/element-hub/add  — internal add (also called from scrap creation)
const addToHub = async (req, res) => {
  try {
    const { elementName, elementId, amount, unit, sourceVin } = req.body;
    if (!elementName || amount == null) return res.status(400).json({ message: "elementName and amount required" });
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "amount must be positive" });

    const hub = await ElementHub.findOneAndUpdate(
      { elementName: String(elementName).trim() },
      { $setOnInsert: { elementId, unit: unit || "lb" }, $inc: { totalWeight: amt } },
      { new: true, upsert: true }
    );

    await ElementHubHistory.create({
      elementHubId: hub._id, elementId, elementName: hub.elementName,
      type: "add", amount: amt, unit: unit || "lb",
      sourceVin: sourceVin?.toUpperCase(), createdBy: req.user?._id,
    });

    res.status(200).json({ hub });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/element-hub/history/:id/print-invoice
const printInvoice = async (req, res) => {
  try {
    const history = await ElementHubHistory.findById(req.params.id)
      .populate("customerId", "firstName lastName mobileNo email address")
      .populate("transactionId")
      .populate("createdBy", "first_name last_name email");

    if (!history) return res.status(404).send("Transaction history not found");
    if (history.type !== "sell") return res.status(400).send("Only sell transactions can have invoices");

    let invoiceDoc = history.invoiceId
      ? await Invoice.findById(history.invoiceId).populate("transaction").populate("createdBy", "first_name last_name email")
      : null;

    if (!invoiceDoc) {
      let trx = history.transactionId;
      if (!trx) {
        trx = await new Transaction({
          type: "credit", amount: 0, paymentMethod: "cash",
          description: `Sale of ${history.amount} ${history.unit || "lb"} ${history.elementName}`,
          status: "completed", createdBy: req.user?._id || history.createdBy?._id,
        }).save();
        await ElementHubHistory.findByIdAndUpdate(history._id, { transactionId: trx._id });
      }

      invoiceDoc = await Invoice.createFrom({
        transactionId: trx._id || trx,
        snapshot: { amount: trx.amount || 0, paymentMethod: trx.paymentMethod, invoiceDate: history.createdAt },
        createdBy: req.user?._id || history.createdBy?._id,
        elementSellId: history._id,
        invoiceType: "element-sell",
      });

      await ElementHubHistory.findByIdAndUpdate(history._id, { invoiceId: invoiceDoc._id });
      invoiceDoc = await Invoice.findById(invoiceDoc._id).populate("transaction").populate("createdBy", "first_name last_name email");
    }

    let logoDataUri = null;
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", "assets", "logo-sm1.png"));
      logoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    } catch { /* ignore */ }

    return res.render("invoice.njk", {
      invoiceDoc, invoicePadded: invoiceDoc.invoiceNumber ? String(invoiceDoc.invoiceNumber).padStart(7, "0") : null,
      customer: history.customerId, transaction: invoiceDoc.transaction || history.transactionId,
      elementSell: history, generatedAt: new Date(),
      generatedBy: req.user ? { id: req.user._id, name: req.user.first_name || "" } : null,
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
    });
  } catch (err) {
    console.error("Print element sell invoice error:", err);
    res.status(500).json({ error: "Server error rendering invoice" });
  }
};

module.exports = { getAllHubItems, getHistory, sellElement, addToHub, printInvoice };
