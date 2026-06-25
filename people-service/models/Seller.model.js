const mongoose = require("mongoose");

const sellerSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true, maxlength: 50 },
  lastName:  { type: String, required: true, trim: true, maxlength: 50 },
  mobileNo:  { type: String, trim: true },
  email:     { type: String, lowercase: true, trim: true },
  driversLicense: { type: String },
  description: { type: String, trim: true },
  isActive:  { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

sellerSchema.index({ email: 1 });
sellerSchema.index({ mobileNo: 1 });
sellerSchema.index({ createdAt: -1 });

sellerSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

sellerSchema.set("toObject", { virtuals: true });
sellerSchema.set("toJSON",   { virtuals: true });

module.exports = mongoose.model("Seller", sellerSchema);
