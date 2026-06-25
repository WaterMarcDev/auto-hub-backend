const mongoose = require("mongoose");
const s = new mongoose.Schema({
  name: String, email: String, phone: String, year: Number,
  make: String, model: String, engineOrVin: String,
  status: { type: String, default: "pending" },
  paymentStatus: { type: String, enum: ["Not Paid", "Cash", "Online"], default: "Not Paid" },
}, { timestamps: true });
module.exports = mongoose.models.JunkCar || mongoose.model("JunkCar", s);
