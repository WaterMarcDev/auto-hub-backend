const mongoose = require("mongoose");

const junkCarSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    year: { type: Number },
    make: { type: String, required: true },
    model: { type: String, required: true },
    engineOrVin: { type: String },
    remark: { type: String, default: "" },
    status: { type: String, default: "pending" },
    source: { type: String, enum: ["Online", "Offline"], default: "Online" },
    paymentStatus: { type: String, enum: ["Not Paid", "Cash", "Online"], default: "Not Paid" },
    movedToIntake: { type: Boolean, default: false },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("JunkCar", junkCarSchema);
