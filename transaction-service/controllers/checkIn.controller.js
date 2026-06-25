const CheckIn = require("../models/CheckIn.model");
const Transaction = require("../models/Transaction.model");
const Invoice = require("../models/Invoice.model");
const Customer = require("../models/Customer.model");
const EntryFee = require("../models/EntryFee.model");
const path = require("path");
const fs = require("fs");

// POST /api/checkins
const create = async (req, res) => {
  try {
    const { customer, type, transaction: txData, numberOfPersons, employeeSignature } = req.body;
    if (!customer) return res.status(400).json({ message: "customer is required" });
    if (!type) return res.status(400).json({ message: "type is required" });
    if (!txData) return res.status(400).json({ message: "transaction data is required" });

    const cust = await Customer.findById(customer);
    if (!cust) return res.status(404).json({ message: "Customer not found" });

    const { amount, paymentMethod } = txData;
    if (amount == null) return res.status(400).json({ message: "transaction.amount is required" });
    if (!paymentMethod) return res.status(400).json({ message: "transaction.paymentMethod is required" });

    const trx = await new Transaction({
      amount, paymentMethod, type: "credit", createdBy: req.user._id,
    }).save();

    const checkIn = await new CheckIn({
      customer, type, transaction: trx._id, numberOfPersons,
      employeeSignature, checkedInBy: req.user._id,
    }).save();

    const populated = await CheckIn.findById(checkIn._id)
      .populate("customer").populate("transaction").populate("checkedInBy", "first_name last_name");
    res.status(201).json(populated);
  } catch (err) {
    console.error("CheckIn create error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// GET /api/checkins
const getAll = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search?.trim();
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    if (search) {
      const re = new RegExp(search, "i");
      const customers = await Customer.find({ $or: [{ firstName: re }, { lastName: re }, { email: re }, { mobileNo: re }] }).select("_id");
      filter.$or = [{ checkInToken: { $regex: search, $options: "i" } }, { customer: { $in: customers.map(c => c._id) } }];
    }

    const [total, items] = await Promise.all([
      CheckIn.countDocuments(filter),
      CheckIn.find(filter).sort({ checkInTime: -1 }).skip((page - 1) * limit).limit(limit)
        .populate("customer").populate("transaction")
        .populate("checkedInBy", "first_name last_name").populate("checkedOutBy", "first_name last_name"),
    ]);
    res.json({ page, limit, total, items });
  } catch (err) {
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// PATCH /api/checkins/:id/checkout
const checkout = async (req, res) => {
  try {
    const checkIn = await CheckIn.findById(req.params.id);
    if (!checkIn) return res.status(404).json({ message: "CheckIn not found" });
    if (checkIn.status === "checked-out") return res.status(400).json({ message: "Already checked out" });

    checkIn.status = "checked-out";
    checkIn.checkOutTime = new Date();
    checkIn.checkedOutBy = req.user._id;
    await checkIn.save();

    const populated = await CheckIn.findById(checkIn._id)
      .populate("customer").populate("transaction")
      .populate("checkedInBy", "first_name last_name").populate("checkedOutBy", "first_name last_name");
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// GET /api/checkins/:id/print-invoice
const printInvoice = async (req, res) => {
  try {
    const checkIn = await CheckIn.findById(req.params.id)
      .populate("customer").populate("transaction").populate("checkedInBy", "first_name last_name email");
    if (!checkIn) return res.status(404).send("CheckIn not found");

    let invoiceDoc = await Invoice.findOne({ checkIn: checkIn._id }).sort({ createdAt: -1 })
      .populate("transaction").populate("createdBy", "first_name last_name email");

    if (!invoiceDoc) {
      const amountPaid = checkIn.transaction?.amount || 0;
      invoiceDoc = await Invoice.create({
        checkIn: checkIn._id, transaction: checkIn.transaction?._id,
        invoiceData: { amount: amountPaid, taxRate: 0, amountPaid, paymentMethod: checkIn.transaction?.paymentMethod },
        paymentMethod: checkIn.transaction?.paymentMethod,
        amount: amountPaid, amountPaid, taxRate: 0,
        invoiceDate: checkIn.checkInTime || new Date(), createdBy: req.user?._id,
      });
      invoiceDoc = await Invoice.findById(invoiceDoc._id)
        .populate("transaction").populate("createdBy", "first_name last_name email");
    }

    let logoDataUri = null;
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", "assets", "logo-sm1.png"));
      logoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    } catch { /* ignore */ }

    const entryFee = await EntryFee.findOne().sort({ createdAt: -1 });
    checkIn.invoicePrinted = true;
    await checkIn.save();

    return res.render("invoice.njk", {
      checkIn, customer: checkIn.customer, transaction: checkIn.transaction,
      invoiceDoc, invoicePadded: invoiceDoc.invoiceNumber ? String(invoiceDoc.invoiceNumber).padStart(7, "0") : null,
      generatedAt: new Date(),
      generatedBy: req.user ? { id: req.user._id, name: req.user.first_name || "" } : null,
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
      adjustedEntryFee: entryFee?.entryFee || 2.0,
    });
  } catch (err) {
    console.error("Print invoice error:", err);
    res.status(500).json({ error: "Server error rendering invoice" });
  }
};

module.exports = { create, getAll, checkout, printInvoice };
