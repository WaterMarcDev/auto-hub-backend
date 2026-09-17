const mongoose = require("mongoose");

const scrapElementSchema = new mongoose.Schema(
  {
    elementName: {
      type: String,
      required: [true, "Element name is required"],
      trim: true,
    },
    unit: {
      type: Number,
      min: [1, "Unit must be at least 1"],
      default: 1,
    },
    quality: {
      type: String,
    },
    weight: {
      type: Number,
    },
    dimensions: {
      type: String,
    },
    vin: {
      type: String,
      required: [true, "VIN is required"],
      trim: true,
      uppercase: true,
    },
    // Soft delete
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

const ScrapElement = mongoose.model("ScrapElement", scrapElementSchema);

module.exports = ScrapElement;
