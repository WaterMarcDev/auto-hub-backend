const mongoose = require("mongoose");

const scrapElementSchema = new mongoose.Schema({
  elementName: { type: String, required: true, trim: true },
  unit: { type: Number, min: 1, default: 1 },
  quality: String,
  weight: Number,
  dimensions: String,
  vin: { type: String, required: true, trim: true, uppercase: true },
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("ScrapElement", scrapElementSchema);
