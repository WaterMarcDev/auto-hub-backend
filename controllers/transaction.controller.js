const { validationResult } = require("express-validator");
const transactionService = require("../services/transaction.service");

function handleError(res, error, label, fallbackError) {
  console.error(`${label}:`, error);
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  return res.status(500).json(fallbackError || { error: "Server error" });
}

// @desc    Create new transaction
// @route   POST /api/transactions
// @access  Private
const createTransaction = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const populatedTransaction = await transactionService.createTransaction(req.body, req.user._id);

    res.status(201).json({
      message: "Transaction created successfully",
      transaction: populatedTransaction,
    });
  } catch (error) {
    handleError(res, error, "Create transaction error", {
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
    const result = await transactionService.getTransactions(req.query);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get transactions error");
  }
};

// @desc    Get single transaction
// @route   GET /api/transactions/:id
// @access  Private
const getTransaction = async (req, res) => {
  try {
    const transaction = await transactionService.getTransaction(req.params.id);
    res.json({ transaction });
  } catch (error) {
    handleError(res, error, "Get transaction error");
  }
};

// @desc    Update transaction
// @route   PUT /api/transactions/:id
// @access  Private
const updateTransaction = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array(),
      });
    }

    const updatedTransaction = await transactionService.updateTransaction(req.params.id, req.body);

    res.json({
      message: "Transaction updated successfully",
      transaction: updatedTransaction,
    });
  } catch (error) {
    handleError(res, error, "Update transaction error", {
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
    const transaction = await transactionService.updateTransactionStatus(req.params.id, status);

    res.json({
      message: "Transaction status updated successfully",
      transaction,
    });
  } catch (error) {
    handleError(res, error, "Update transaction status error");
  }
};

// @desc    Delete transaction
// @route   DELETE /api/transactions/:id
// @access  Private
const deleteTransaction = async (req, res) => {
  try {
    await transactionService.deleteTransaction(req.params.id);
    res.json({ message: "Transaction deleted successfully" });
  } catch (error) {
    handleError(res, error, "Delete transaction error");
  }
};

// @desc    Get transactions by car intake
// @route   GET /api/transactions/car-intake/:carIntakeId
// @access  Private
const getTransactionsByCarIntake = async (req, res) => {
  try {
    const result = await transactionService.getTransactionsByCarIntake(req.params.carIntakeId);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get transactions by car intake error");
  }
};

// @desc    Get transactions by seller
// @route   GET /api/transactions/seller/:sellerId
// @access  Private
const getTransactionsBySeller = async (req, res) => {
  try {
    const result = await transactionService.getTransactionsBySeller(req.params.sellerId);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get transactions by seller error");
  }
};

// @desc    Get transaction statistics
// @route   GET /api/transactions/stats
// @access  Private
const getTransactionStats = async (req, res) => {
  try {
    const result = await transactionService.getTransactionStats(req.query);
    res.json(result);
  } catch (error) {
    handleError(res, error, "Get transaction stats error");
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
