const mongoose = require("mongoose");
const s = new mongoose.Schema({
  firstName: String, lastName: String, mobileNo: String, email: String,
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });
module.exports = mongoose.models.Customer || mongoose.model("Customer", s);
