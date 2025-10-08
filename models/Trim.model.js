const mongoose = require("mongoose");

const trimSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Trim name is required"],
      trim: true,
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
    shortName: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
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

const Trim = mongoose.model("Trim", trimSchema);

module.exports = Trim;
