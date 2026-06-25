const mongoose = require("mongoose");

const PartRequestSchema = new mongoose.Schema({
  name:      String,
  phone:     String,
  email:     String,
  make:      String,
  model:     String,
  year:      Number,
  partName:  String,
  condition: String,
  message:   String,
  remark:    { type: String, default: "" },
  source:    { type: String, enum: ["Online", "Offline"], default: "Online" },
  status:    { type: String, enum: ["Pending", "In Progress", "Completed", "Rejected"], default: "Pending" },
  fulfilledBy: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model("PartRequest", PartRequestSchema);
