const mongoose = require("mongoose");

const checkInSchema = new mongoose.Schema({
  checkInToken: { type: String, unique: true, trim: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  type: { type: String, enum: ["seller", "buyer", "both"], required: true },
  numberOfPersons: Number,
  transaction: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", required: true },
  employeeSignature: { type: String, trim: true },
  checkInTime: { type: Date, default: Date.now },
  checkOutTime: Date,
  status: { type: String, enum: ["checked-in", "checked-out"], default: "checked-in" },
  checkedInBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  checkedOutBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  invoicePrinted: { type: Boolean, default: false },
});

checkInSchema.pre("save", function (next) {
  if (!this.checkInToken) {
    this.checkInToken = Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  next();
});

module.exports = mongoose.models.CheckIn || mongoose.model("CheckIn", checkInSchema);
