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
    description: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

const Part = mongoose.model("Part", partSchema);

module.exports = Part;
