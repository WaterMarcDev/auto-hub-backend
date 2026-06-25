const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Model name is required"], trim: true },
    make: { type: mongoose.Schema.Types.ObjectId, ref: "Make", required: true },
    shortName: { type: String, trim: true },
    description: { type: String, trim: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("CarModel", modelSchema);
