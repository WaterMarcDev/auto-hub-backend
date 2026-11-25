const mongoose = require("mongoose");

const entryFeeSchema = new mongoose.Schema(
  {
    entryFee: {
      type: Number,
      default: 2.0,
      required: [true, "Entry fee is required"],
      // Same limits as controllers/entryFee.controller.js (money, 2 decimals).
      min: [0, "Entry fee cannot be negative"],
      max: [10, "Entry fee can be at most $10"],
      validate: {
        validator: (v) => v == null || Math.abs(Math.round(v * 100) - v * 100) < 1e-6,
        message: "Entry fee can have at most 2 decimal places",
      },
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("EntryFee", entryFeeSchema);
