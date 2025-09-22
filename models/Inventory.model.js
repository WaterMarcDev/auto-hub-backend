const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema(
  {
    partName: {
      type: String,
      required: [true, "Part name is required"],
      trim: true,
    },
    unit: {
      type: String,
      required: [true, "Unit is required"],
      trim: true,
    },
    cleaned: {
      type: Boolean,
      default: false,
    },
    quality: {
      type: String,
    },
    location: {
      type: String,
    },
    weight: {
      type: Number,
    },
    dimensions: {
      type: String,
    },
    make: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Make",
      required: [true, "Make reference is required"],
    },
    model: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CarModel",
      required: [true, "Model reference is required"],
    },
    trim: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trim",
      required: [true, "Trim reference is required"],
    },
    vin: {
      type: String,
      trim: true,
    },
    tag: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);
const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = Inventory;
