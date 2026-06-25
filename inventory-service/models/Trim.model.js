const mongoose = require("mongoose");
const s = new mongoose.Schema({ name: { type: String, required: true, trim: true }, make: { type: mongoose.Schema.Types.ObjectId, ref: "Make", required: true }, model: { type: mongoose.Schema.Types.ObjectId, ref: "CarModel", required: true }, shortName: { type: String, trim: true }, isDeleted: { type: Boolean, default: false } }, { timestamps: true });
module.exports = mongoose.models.Trim || mongoose.model("Trim", s);
