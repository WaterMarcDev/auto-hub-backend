const mongoose = require("mongoose");

const elementSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  shortName: { type: String, trim: true },
  weight: Number,
  dimensions: { type: String, trim: true },
  description: { type: String, trim: true },
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("Element", elementSchema);
