const mongoose = require("mongoose");

const partSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Part name is required"],
      trim: true,
    },
    shortName: {
      type: String,
      trim: true,
    },

    // Added by shiva
    category: {
      type: String,
      trim: true,
      default: "Uncategorized",
    },
    // end here
    unit: {
      type: String,
      trim: true,
    },
    weight: {
      type: Number,
    },
    dimensions: {
      type: String,
      trim: true,
    },
    image: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    // Soft delete flag and timestamp
    deleted: {
      type: Boolean,
      default: false,
    },
    // Compatibility: isDeleted alias
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

const Part = mongoose.model("Part", partSchema);

module.exports = Part;
