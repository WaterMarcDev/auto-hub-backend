const mongoose = require("mongoose");

const elementHubSchema = new mongoose.Schema({
  elementId: { type: mongoose.Schema.Types.ObjectId, ref: "Element" },
  elementName: { type: String, required: true, trim: true },
  totalWeight: { type: Number, default: 0 },
  unit: { type: String, default: "lb", trim: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("ElementHub", elementHubSchema);
