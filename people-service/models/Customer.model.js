const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema({
  firstName:      { type: String, required: true, trim: true },
  lastName:       { type: String, required: true, trim: true },
  mobileNo:       { type: String, trim: true },
  email:          { type: String, lowercase: true, trim: true },
  idProofType:    String,
  idProofNumber:  String,
  idProofImage:   String,
  signatureImage: String,
  createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  isDeleted:      { type: Boolean, default: false },
  deletedAt:      Date,
}, { timestamps: true });

module.exports = mongoose.model("Customer", CustomerSchema);
