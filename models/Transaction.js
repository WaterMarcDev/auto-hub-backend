const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    // Transaction Type
    type: {
      type: String,
      enum: ["debit", "credit"],
      required: [true, "Transaction type is required"],
    },

    // Amount
    amount: {
      type: Number,
      // required: [true, "Transaction amount is required"],
      // min: [0.01, "Amount must be greater than 0"],
    },

    // Related Records
    carIntake: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CarIntake",
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
    },

    // Payment Information (matching the form)
    paymentMethod: {
      type: String,
      // enum: ["Cash", "Bank Transfer", "Zelle"],
      // required: [true, "Payment method is required"],
    },

    // Transaction Details
    description: {
      type: String,
      trim: true,
    },

    // Status
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "pending",
    },

    // Date
    transactionDate: {
      type: Date,
      default: Date.now,
    },

    // Staff Information
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Creator is required"],
    },

    // Metadata
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ transactionDate: -1 });
transactionSchema.index({ carIntake: 1 });
transactionSchema.index({ seller: 1 });
transactionSchema.index({ createdBy: 1 });
transactionSchema.index({ createdAt: -1 });

// Virtual for formatted amount
transactionSchema.virtual("formattedAmount").get(function () {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(this.amount);
});

module.exports = mongoose.model("Transaction", transactionSchema);
