const mongoose = require("mongoose");

const makeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Make name is required"],
      unique: true,
      trim: true,
    },
    shortName: {
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

const Make = mongoose.model("Make", makeSchema);

module.exports = Make;
