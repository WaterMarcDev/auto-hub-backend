const mongoose = require("mongoose");

const partSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  shortName: { type: String, trim: true },
  category: { type: String, trim: true, default: "Uncategorized" },
  unit: { type: String, trim: true },
  weight: Number,
  dimensions: { type: String, trim: true },
  image: { type: String, trim: true },
  description: { type: String, trim: true },
  deleted: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("Part", partSchema);
