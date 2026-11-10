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
      // "adjust" = a signed correction written when a Scrap Purchase that
      // already added stock is edited down or deleted (amount is negative).
      enum: ["add", "sell", "adjust"],
      required: true,
    },
    // Where stock came from: "scrap-purchase" (bought as scrap material).
    // Car-extraction rows have no value here and are identified by sourceVin.
    source: {
      type: String,
      trim: true,
    },
    scrapPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScrapPurchase",
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
        // Scrap Purchase stock has no car; it is identified by scrapPurchaseId.
        return this.type === "add" && !this.scrapPurchaseId;
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
