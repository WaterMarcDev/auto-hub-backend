const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { auth } = require("../middleware/auth");
const {
  createTransaction,
  getTransactions,
  getTransaction,
  updateTransaction,
  updateTransactionStatus,
  deleteTransaction,
  getTransactionsByCarIntake,
  getTransactionsBySeller,
  getTransactionStats,
} = require("../controllers/transactionController");

// Validation middleware
const validateTransaction = [
  body("type")
    .isIn(["debit", "credit"])
    .withMessage("Valid transaction type is required"),
  body("amount").isFloat({ min: 0.01 }).withMessage("Valid amount is required"),
  body("paymentMethod")
    .isIn(["Cash", "Bank Transfer", "Zelle"])
    .withMessage("Valid payment method is required"),
];

// @route   GET /api/transactions/stats
// @desc    Get transaction statistics
// @access  Private
router.get("/stats", auth, getTransactionStats);

// @route   GET /api/transactions/car-intake/:carIntakeId
// @desc    Get transactions by car intake
// @access  Private
router.get("/car-intake/:carIntakeId", auth, getTransactionsByCarIntake);

// @route   GET /api/transactions/seller/:sellerId
// @desc    Get transactions by seller
// @access  Private
router.get("/seller/:sellerId", auth, getTransactionsBySeller);

// @route   POST /api/transactions
// @desc    Create new transaction
// @access  Private
router.post("/", auth, validateTransaction, createTransaction);

// @route   GET /api/transactions
// @desc    Get all transactions
// @access  Private
router.get("/", auth, getTransactions);

// @route   GET /api/transactions/:id
// @desc    Get single transaction
// @access  Private
router.get("/:id", auth, getTransaction);

// @route   PUT /api/transactions/:id
// @desc    Update transaction
// @access  Private
router.put("/:id", auth, validateTransaction, updateTransaction);

// @route   PATCH /api/transactions/:id/status
// @desc    Update transaction status
// @access  Private
router.patch("/:id/status", auth, updateTransactionStatus);

// @route   DELETE /api/transactions/:id
// @desc    Delete transaction
// @access  Private
router.delete("/:id", auth, deleteTransaction);

module.exports = router;
