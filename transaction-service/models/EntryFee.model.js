const mongoose = require("mongoose");
const s = new mongoose.Schema({
  entryFee: { type: Number, default: 2.0, required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
module.exports = mongoose.models.EntryFee || mongoose.model("EntryFee", s);
