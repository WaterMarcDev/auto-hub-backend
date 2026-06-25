const mongoose = require("mongoose");
const s = new mongoose.Schema({ vin: String, carDetails: { year: Number, make: String, model: String, trim: String }, vinDetails: Object, isDeleted: { type: Boolean, default: false } }, { timestamps: true });
module.exports = mongoose.models.CarIntake || mongoose.model("CarIntake", s);
