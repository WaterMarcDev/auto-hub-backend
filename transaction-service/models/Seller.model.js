const mongoose = require("mongoose");
const s = new mongoose.Schema({
  firstName: String, lastName: String, mobileNo: String, email: String,
  isActive: { type: Boolean, default: true }, isDeleted: { type: Boolean, default: false },
}, { timestamps: true });
s.virtual("fullName").get(function () { return `${this.firstName} ${this.lastName}`; });
module.exports = mongoose.models.Seller || mongoose.model("Seller", s);
