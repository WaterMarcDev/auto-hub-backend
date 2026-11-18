/**
 * MarketplaceEvent — durable inbox for verified marketplace notifications
 * (eBay Notification API webhooks). The webhook only verifies and stores the
 * event, then acknowledges; jobs/inventorySyncWorkerJob.js processes it.
 *
 * eventId (eBay notificationId) is unique, so a re-delivered notification is
 * stored once.
 */
const mongoose = require("mongoose");

const MarketplaceEventSchema = new mongoose.Schema(
  {
    channel: { type: String, required: true },         // "ebay"
    eventId: { type: String, required: true, unique: true },
    topic: { type: String, required: true },           // e.g. ORDER_CONFIRMATION
    orderId: { type: String, index: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    // received → processing → done | ignored | failed (retried) | dead (gave up)
    status: {
      type: String,
      enum: ["received", "processing", "done", "ignored", "failed", "dead"],
      default: "received",
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date },
    lastError: { type: String },
    result: { type: mongoose.Schema.Types.Mixed },
    processedAt: { type: Date },
  },
  { timestamps: true }
);

MarketplaceEventSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model("MarketplaceEvent", MarketplaceEventSchema);
