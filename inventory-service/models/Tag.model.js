const mongoose = require("mongoose");

const tagSchema = new mongoose.Schema({
  barcodeNumber: { type: Number, required: true, unique: true, index: true },
  digits: { type: Number, required: true },
  barcodeString: { type: String, required: true, unique: true, index: true },
  isUsed: { type: Boolean, default: false },
  inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Inventory", default: null, index: true },
}, { timestamps: true });

module.exports = mongoose.model("Tag", tagSchema);
