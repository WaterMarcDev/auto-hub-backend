const mongoose = require("mongoose");
const s = new mongoose.Schema({ name: { type: String, required: true, trim: true }, make: { type: mongoose.Schema.Types.ObjectId, ref: "Make", required: true }, shortName: { type: String, trim: true }, isDeleted: { type: Boolean, default: false } }, { timestamps: true });
module.exports = mongoose.models.CarModel || mongoose.model("CarModel", s);
