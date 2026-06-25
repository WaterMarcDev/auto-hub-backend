const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const {
  createTransaction, getTransactions, getTransaction,
  updateTransaction, updateTransactionStatus, deleteTransaction, getTransactionStats,
} = require("../controllers/transaction.controller");

router.get("/stats", auth, getTransactionStats);
router.post("/", auth, createTransaction);
router.get("/", auth, getTransactions);
router.get("/:id", auth, getTransaction);
router.put("/:id", auth, updateTransaction);
router.patch("/:id/status", auth, updateTransactionStatus);
router.delete("/:id", auth, deleteTransaction);

module.exports = router;
