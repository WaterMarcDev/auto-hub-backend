// Lightweight — inventory-service only creates credit transactions for element sells
const mongoose = require("mongoose");
const s = new mongoose.Schema({
  type: { type: String, enum: ["debit", "credit"], required: true },
  amount: Number,
  taxRate: { type: Number, default: 0.06625 },
  taxAmount: { type: Number, default: 0 },
  netAmount: { type: Number, default: 0 },
  paymentMethod: String,
  description: String,
  status: { type: String, enum: ["pending", "completed", "failed", "cancelled"], default: "pending" },
  transactionDate: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });
module.exports = mongoose.models.Transaction || mongoose.model("Transaction", s);
