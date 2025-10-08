const mongoose = require("mongoose");

const WaiverSchema = new mongoose.Schema(
  {
    customerType: {
      type: String,
      enum: ["seller", "buyer"],
      required: true,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
    },
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Buyer",
    },
    idProofType: {
      type: String,
    },
    idProofNumber: {
      type: String,
    },
    idProofImage: {
      type: String,
    },
    signatureImage: {
      type: String,
    },
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    employeeSignature: {
      type: String,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Waiver", WaiverSchema);
