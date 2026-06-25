const mongoose = require("mongoose");
const s = new mongoose.Schema({ name: { type: String, required: true, unique: true, trim: true }, shortName: { type: String, trim: true }, isDeleted: { type: Boolean, default: false } }, { timestamps: true });
module.exports = mongoose.models.Make || mongoose.model("Make", s);
