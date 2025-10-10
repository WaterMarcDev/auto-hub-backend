const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["seller", "buyer"],
      required: true,
    },
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    mobileNo: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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

module.exports = mongoose.model("Customer", CustomerSchema);
