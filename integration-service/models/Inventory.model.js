const mongoose = require("mongoose");
const s = new mongoose.Schema({
  partName: String, unit: String, cleaned: Boolean, quality: String, location: String,
  weight: Number, dimensions: String,
  make:  { type: mongoose.Schema.Types.ObjectId, ref: "Make" },
  model: { type: mongoose.Schema.Types.ObjectId, ref: "CarModel" },
  trim:  { type: mongoose.Schema.Types.ObjectId, ref: "Trim" },
  year: Number, vin: String, sku: String,
  category: { type: String, default: "Uncategorized" },
  image: { type: String, default: null },
  wixSynced: { type: Boolean, default: false },
  wixSyncedAt: Date,
  wixProductId: { type: String, default: null },
  wixInventoryItemId: { type: String, default: null },
  wixVariantId: { type: String, default: null },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });
module.exports = mongoose.models.Inventory || mongoose.model("Inventory", s);
