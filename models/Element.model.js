const mongoose = require("mongoose");

const elementSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Element name is required"],
      trim: true,
    },
    shortName: {
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
    description: {
      type: String,
      trim: true,
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

const Element = mongoose.model("Element", elementSchema);

module.exports = Element;
