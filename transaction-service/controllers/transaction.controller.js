const Transaction = require("../models/Transaction.model");
const CarIntake = require("../models/CarIntake.model");
const JunkCar = require("../models/JunkCar.model");

// POST /api/transactions
const createTransaction = async (req, res) => {
  try {
    const transaction = await new Transaction({ ...req.body, createdBy: req.user._id }).save();
    const populated = await Transaction.findById(transaction._id)
      .populate("carIntake", "vin carDetails.make carDetails.model carDetails.year")
      .populate("seller", "firstName lastName email")
      .populate("createdBy", "first_name last_name email");
    res.status(201).json({ message: "Transaction created successfully", transaction: populated });
  } catch (error) {
    console.error("Create transaction error:", error);
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/transactions
const getTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const filter = { isActive: true };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
    if (req.query.startDate || req.query.endDate) {
      filter.transactionDate = {};
      if (req.query.startDate) filter.transactionDate.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.transactionDate.$lte = new Date(req.query.endDate);
    }
    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .populate("carIntake", "vin carDetails.make carDetails.model carDetails.year")
        .populate("seller", "firstName lastName email")
        .populate("createdBy", "first_name last_name email")
        .sort({ transactionDate: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(filter),
    ]);
    res.json({ transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/transactions/:id
const getTransaction = async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, isActive: true })
      .populate("carIntake", "vin carDetails.make carDetails.model carDetails.year")
      .populate("seller", "firstName lastName email")
      .populate("createdBy", "first_name last_name email");
    if (!transaction) return res.status(404).json({ error: "Transaction not found" });
    res.json({ transaction });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/transactions/:id
const updateTransaction = async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, isActive: true });
    if (!transaction) return res.status(404).json({ error: "Transaction not found" });
    Object.assign(transaction, req.body);
    await transaction.save();
    const updated = await Transaction.findById(transaction._id)
      .populate("carIntake", "vin carDetails.make").populate("createdBy", "first_name last_name email");
    res.json({ message: "Transaction updated successfully", transaction: updated });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// PATCH /api/transactions/:id/status
const updateTransactionStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "completed", "failed", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const transaction = await Transaction.findByIdAndUpdate(req.params.id, { status }, { new: true })
      .populate("carIntake", "vin carDetails.make").populate("seller", "firstName lastName");

    // When completed & linked to junk car, move it to intake
    if (status === "completed" && transaction?.junkCar) {
      try {
        const junk = await JunkCar.findById(transaction.junkCar);
        if (junk) {
          junk.paymentStatus = "Online"; junk.status = "completed";
          await junk.save();
          const vinValue = junk.engineOrVin?.trim().length > 5
            ? junk.engineOrVin.toUpperCase() : `JUNK${Date.now()}`;
          const exists = await CarIntake.findOne({ vin: vinValue });
          if (!exists) {
            await CarIntake.create({
              vin: vinValue,
              carDetails: { year: junk.year, make: junk.make, model: junk.model, trim: "Junk Car" },
              status: "intake",
            });
          }
        }
      } catch (e) { console.error("JunkCar post-payment error:", e.message); }
    }

    if (!transaction) return res.status(404).json({ error: "Transaction not found" });
    res.json({ message: "Transaction status updated", transaction });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/transactions/:id
const deleteTransaction = async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, isActive: true });
    if (!transaction) return res.status(404).json({ error: "Transaction not found" });
    transaction.isActive = false;
    await transaction.save();
    res.json({ message: "Transaction deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/transactions/stats
const getTransactionStats = async (req, res) => {
  try {
    const matchStage = { isActive: true };
    if (req.query.startDate) matchStage.transactionDate = { $gte: new Date(req.query.startDate) };
    if (req.query.endDate) matchStage.transactionDate = { ...matchStage.transactionDate, $lte: new Date(req.query.endDate) };
    if (req.query.type) matchStage.type = req.query.type;
    const [stats, summary] = await Promise.all([
      Transaction.aggregate([{ $match: matchStage }, { $group: { _id: { type: "$type", status: "$status" }, count: { $sum: 1 }, totalAmount: { $sum: "$amount" } } }]),
      Transaction.aggregate([{ $match: matchStage }, { $group: { _id: "$type", count: { $sum: 1 }, totalAmount: { $sum: "$amount" } } }]),
    ]);
    res.json({ stats, summary });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createTransaction, getTransactions, getTransaction, updateTransaction, updateTransactionStatus, deleteTransaction, getTransactionStats };
