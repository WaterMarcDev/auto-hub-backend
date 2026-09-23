const mongoose = require("mongoose");

const elementHubHistorySchema = new mongoose.Schema(
  {
    elementHubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ElementHub",
    },
    elementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Element",
    },
    elementName: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["add", "sell"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    unit: {
      type: String,
      default: "lb",
    },
    sourceVin: {
      type: String,
      trim: true,
      uppercase: true,
      required: function () {
        // sourceVin is required for 'add' transactions (extractions) but optional for sells
        return this.type === "add";
      },
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: function () {
        // customerId is required for 'sell' transactions but optional for adds
        return this.type === "sell";
      },
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },
    note: {
      type: String,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

const ElementHubHistory = mongoose.model(
  "ElementHubHistory",
  elementHubHistorySchema
);

module.exports = ElementHubHistory;
