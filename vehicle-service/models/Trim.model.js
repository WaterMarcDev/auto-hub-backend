const mongoose = require("mongoose");

const trimSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Trim name is required"], trim: true },
    make: { type: mongoose.Schema.Types.ObjectId, ref: "Make", required: true },
    model: { type: mongoose.Schema.Types.ObjectId, ref: "CarModel", required: true },
    shortName: { type: String, trim: true },
    description: { type: String, trim: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Trim", trimSchema);
