const mongoose = require("mongoose");
const s = new mongoose.Schema({ name: { type: String, trim: true }, make: { type: mongoose.Schema.Types.ObjectId, ref: "Make" }, model: { type: mongoose.Schema.Types.ObjectId, ref: "CarModel" }, shortName: { type: String, trim: true }, isDeleted: { type: Boolean, default: false } }, { timestamps: true });
module.exports = mongoose.models.Trim || mongoose.model("Trim", s);
