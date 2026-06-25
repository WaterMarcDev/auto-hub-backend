const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema({
  partName: { type: String, required: true, trim: true },
  unit: { type: String, required: true, trim: true },
  cleaned: { type: Boolean, default: false },
  quality: String,
  location: String,
  weight: Number,
  dimensions: String,
  make: { type: mongoose.Schema.Types.ObjectId, ref: "Make", required: true },
  model: { type: mongoose.Schema.Types.ObjectId, ref: "CarModel", required: true },
  trim: { type: mongoose.Schema.Types.ObjectId, ref: "Trim", required: true },
  year: Number,
  vin: { type: String, trim: true },
  sku: { type: String, trim: true },
  category: { type: String, trim: true, default: "Uncategorized" },
  image: { type: String, default: null },
  wixSynced: { type: Boolean, default: false },
  wixSyncedAt: Date,
  wixProductId: { type: String, default: null },
  wixInventoryItemId: { type: String, default: null },
  wixVariantId: { type: String, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
}, { timestamps: true });

inventorySchema.index({ vin: 1, partName: 1 }, { unique: true });

module.exports = mongoose.model("Inventory", inventorySchema);
