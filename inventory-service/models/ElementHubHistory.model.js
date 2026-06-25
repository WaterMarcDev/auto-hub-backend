const mongoose = require("mongoose");

const elementHubHistorySchema = new mongoose.Schema({
  elementHubId: { type: mongoose.Schema.Types.ObjectId, ref: "ElementHub" },
  elementId: { type: mongoose.Schema.Types.ObjectId, ref: "Element" },
  elementName: { type: String, required: true },
  type: { type: String, enum: ["add", "sell"], required: true },
  amount: { type: Number, required: true },
  unit: { type: String, default: "lb" },
  sourceVin: { type: String, trim: true, uppercase: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
  note: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

module.exports = mongoose.model("ElementHubHistory", elementHubHistorySchema);
