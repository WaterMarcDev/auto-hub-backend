const Transaction = require("../models/Transaction");
const CarIntake = require("../models/carInTake.model");
const Seller = require("../models/Seller");
const { validationResult } = require("express-validator");

// @desc    Create new transaction
// @route   POST /api/transactions
// @access  Private
const createTransaction = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const transaction = new Transaction({
      ...req.body,
      createdBy: req.user._id,
    });

    await transaction.save();

    const populatedTransaction = await Transaction.findById(transaction._id)
      .populate("carIntake", "vin make model year")
      .populate("seller", "firstName lastName email")
      .populate("createdBy", "first_name last_name email");

    res.status(201).json({
      message: "Transaction created successfully",
      transaction: populatedTransaction,
    });
  } catch (error) {
    console.error("Create transaction error:", error);
    res.status(500).json({
      error: "Server error during transaction creation",
      details: error.message,
    });
  }
};

// @desc    Get all transactions
// @route   GET /api/transactions
// @access  Private
const getTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = { isActive: true };
    if (req.query.type) {
      filter.type = req.query.type;
    }
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.paymentMethod) {
      filter.paymentMethod = req.query.paymentMethod;
    }
    if (req.query.startDate || req.query.endDate) {
      filter.transactionDate = {};
      if (req.query.startDate) {
        filter.transactionDate.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.transactionDate.$lte = new Date(req.query.endDate);
      }
    }

    const transactions = await Transaction.find(filter)
      .populate("carIntake", "vin make model year finalPrice")
      .populate("seller", "firstName lastName email mobileNo")
      .populate("createdBy", "first_name last_name email")
      .sort({ transactionDate: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Transaction.countDocuments(filter);

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get transactions error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get single transaction
// @route   GET /api/transactions/:id
// @access  Private
const getTransaction = async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id)
      .populate("carIntake", "vin make model year finalPrice status")
      .populate("seller", "firstName lastName email mobileNo")
      .populate("createdBy", "first_name last_name email");

    if (!transaction || !transaction.isActive) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json({ transaction });
  } catch (error) {
    console.error("Get transaction error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update transaction
// @route   PUT /api/transactions/:id
// @access  Private
const updateTransaction = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || !transaction.isActive) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Update transaction
    Object.assign(transaction, req.body);
    await transaction.save();

    const updatedTransaction = await Transaction.findById(transaction._id)
      .populate("carIntake", "vin make model year finalPrice")
      .populate("seller", "firstName lastName email")
      .populate("createdBy", "first_name last_name email");

    res.json({
      message: "Transaction updated successfully",
      transaction: updatedTransaction,
    });
  } catch (error) {
    console.error("Update transaction error:", error);
    res.status(500).json({
      error: "Server error during update",
      details: error.message,
    });
  }
};

// @desc    Update transaction status
// @route   PATCH /api/transactions/:id/status
// @access  Private
const updateTransactionStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!["pending", "completed", "failed", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const transaction = await Transaction.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    )
      .populate("carIntake", "vin make model year")
      .populate("seller", "firstName lastName email");

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json({
      message: "Transaction status updated successfully",
      transaction,
    });
  } catch (error) {
    console.error("Update transaction status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Delete transaction
// @route   DELETE /api/transactions/:id
// @access  Private
const deleteTransaction = async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || !transaction.isActive) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Soft delete - set isActive to false
    transaction.isActive = false;
    await transaction.save();

    res.json({ message: "Transaction deleted successfully" });
  } catch (error) {
    console.error("Delete transaction error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get transactions by car intake
// @route   GET /api/transactions/car-intake/:carIntakeId
// @access  Private
const getTransactionsByCarIntake = async (req, res) => {
  try {
    const { carIntakeId } = req.params;

    const carIntake = await CarIntake.findById(carIntakeId);
    if (!carIntake) {
      return res.status(404).json({ error: "Car intake not found" });
    }

    const transactions = await Transaction.find({
      carIntake: carIntakeId,
      isActive: true,
    })
      .populate("seller", "firstName lastName email")
      .populate("createdBy", "first_name last_name email")
      .sort({ transactionDate: -1 });

    res.json({
      carIntake: {
        id: carIntake._id,
        vin: carIntake.vin,
        make: carIntake.make,
        model: carIntake.model,
        year: carIntake.year,
      },
      transactions,
    });
  } catch (error) {
    console.error("Get transactions by car intake error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get transactions by seller
// @route   GET /api/transactions/seller/:sellerId
// @access  Private
const getTransactionsBySeller = async (req, res) => {
  try {
    const { sellerId } = req.params;

    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    const transactions = await Transaction.find({
      seller: sellerId,
      isActive: true,
    })
      .populate("carIntake", "vin make model year")
      .populate("createdBy", "first_name last_name email")
      .sort({ transactionDate: -1 });

    res.json({
      seller: {
        id: seller._id,
        fullName: seller.fullName,
        email: seller.email,
        mobileNo: seller.mobileNo,
      },
      transactions,
    });
  } catch (error) {
    console.error("Get transactions by seller error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get transaction statistics
// @route   GET /api/transactions/stats
// @access  Private
const getTransactionStats = async (req, res) => {
  try {
    const { startDate, endDate, type } = req.query;

    const matchStage = { isActive: true };
    if (startDate || endDate) {
      matchStage.transactionDate = {};
      if (startDate) matchStage.transactionDate.$gte = new Date(startDate);
      if (endDate) matchStage.transactionDate.$lte = new Date(endDate);
    }
    if (type) {
      matchStage.type = type;
    }

    const stats = await Transaction.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            type: "$type",
            status: "$status",
            paymentMethod: "$paymentMethod",
          },
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          averageAmount: { $avg: "$amount" },
        },
      },
    ]);

    const summary = await Transaction.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const dailyStats = await Transaction.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$transactionDate" },
            },
            type: "$type",
          },
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
      { $sort: { "_id.date": -1 } },
      { $limit: 30 }, // Last 30 days
    ]);

    res.json({
      stats,
      summary,
      dailyStats,
    });
  } catch (error) {
    console.error("Get transaction stats error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  createTransaction,
  getTransactions,
  getTransaction,
  updateTransaction,
  updateTransactionStatus,
  deleteTransaction,
  getTransactionsByCarIntake,
  getTransactionsBySeller,
  getTransactionStats,
};
