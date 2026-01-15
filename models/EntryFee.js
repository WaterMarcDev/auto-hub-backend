const mongoose = require("mongoose");

const entryFeeSchema = new mongoose.Schema(
  {
    entryFee: {
      type: Number,
      default: 2.0,
      required: [true, "Entry fee is required"],
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
