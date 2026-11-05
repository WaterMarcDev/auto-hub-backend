/**
 * MarketplaceSaleSync — one document per channel ("ebay", "wix") recording
 * the last run of the sold-status sync (services/marketplaceSales.service.js).
 *
 * lastSuccessAt drives the next run's look-back window; the rest is shown on
 * the Sold Products page so staff can see the sync is healthy and which sold
 * order lines could not be matched to a CRM part.
 */
const mongoose = require("mongoose");

const MarketplaceSaleSyncSchema = new mongoose.Schema(
  {
    _id: { type: String }, // channel: "ebay" | "wix"
    lastRunAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastStatus: { type: String, default: null }, // success | failed | skipped
    lastError: { type: String, default: null },
    lastSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Sold lines from the last run that matched no CRM part (capped list).
    unmatched: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model("MarketplaceSaleSync", MarketplaceSaleSyncSchema);
