const mongoose = require("mongoose");
const schema = new mongoose.Schema({ entryFee: { type: Number, default: 2.0 }, updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" } }, { timestamps: true });
module.exports = mongoose.models.EntryFee || mongoose.model("EntryFee", schema);
