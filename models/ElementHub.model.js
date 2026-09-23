const mongoose = require("mongoose");

const elementHubSchema = new mongoose.Schema(
  {
    elementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Element",
    },
    elementName: {
      type: String,
      required: [true, "Element name is required"],
      trim: true,
    },
    totalWeight: {
      type: Number,
      default: 0,
    },
    unit: {
      type: String,
      default: "lb",
      trim: true,
    },
    // Soft delete if needed in future
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const ElementHub = mongoose.model("ElementHub", elementHubSchema);

module.exports = ElementHub;
