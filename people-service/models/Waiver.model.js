const mongoose = require("mongoose");

const WaiverSchema = new mongoose.Schema({
  customerType:   { type: String, enum: ["seller", "buyer"], required: true },
  seller:         { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
  buyer:          { type: mongoose.Schema.Types.ObjectId, ref: "Buyer" },
  idProofType:    String,
  idProofNumber:  String,
  idProofImage:   String,
  signatureImage: String,
  payment:        { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
  employeeSignature: String,
  createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  isDeleted:      { type: Boolean, default: false },
  deletedAt:      Date,
}, { timestamps: true });

module.exports = mongoose.model("Waiver", WaiverSchema);
