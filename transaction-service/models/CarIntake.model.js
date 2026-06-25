// Lightweight stub — transaction-service only reads carIntake for references
const mongoose = require("mongoose");
const s = new mongoose.Schema({
  vin: String,
  carDetails: { year: Number, make: String, model: String, trim: String },
  price: { finalPrice: Number },
  status: String,
  payment: { paymentMethod: String, paidAmount: Number },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });
module.exports = mongoose.models.CarIntake || mongoose.model("CarIntake", s);
