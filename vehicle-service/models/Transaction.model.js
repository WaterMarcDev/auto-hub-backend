// Lightweight Transaction model — vehicle-service only reads/creates transactions linked to car intakes
const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["debit", "credit"], required: true },
    amount: Number,
    taxRate: { type: Number, default: 0.06625 },
    taxAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    amountIsNet: { type: Boolean, default: false },
    carIntake: { type: mongoose.Schema.Types.ObjectId, ref: "CarIntake" },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
    paymentMethod: String,
    description: { type: String, trim: true },
    status: { type: String, enum: ["pending", "completed", "failed", "cancelled"], default: "pending" },
    transactionDate: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);
