const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ["ebay", "amazon"],
      default: "ebay",
      index: true,
    },

    // NOTE: `orderId` is intentionally NOT unique on its own — uniqueness is
    // enforced by the compound index below ({platform, orderId}), scoped per
    // marketplace so an Amazon order can never collide with/overwrite an
    // eBay order that happens to share the same orderId value.
    orderId: {
      type: String,
      required: true,
      index: true,
    },

    legacyOrderId: {
      type: String,
      default: null,
    },

    buyerUsername: {
      type: String,
      default: null,
    },

    buyerEmail: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      default: null,
    },

    // Newer, more granular status fields (additive — `status` above is left
    // untouched for backward compatibility with anything already reading it).
    paymentStatus: {
      type: String,
      default: null,
    },

    shippingStatus: {
      type: String,
      default: null,
    },

    // Best-effort, derived only from signals already present on the same
    // Fulfillment API order object (no dedicated refund/return API
    // integration exists) — see services/orderStatusMapper.js.
    refundStatus: {
      type: String,
      default: "Not Refunded",
    },

    trackingNumber: {
      type: String,
      default: null,
    },

    carrier: {
      type: String,
      default: null,
    },

    trackingUrl: {
      type: String,
      default: null,
    },

    // CRM linkage (all optional — populated by the adapter/customer-match
    // flow on upsert; existing documents without these simply read as null).
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },

    customerName: {
      type: String,
      default: null,
    },

    customerPhone: {
      type: String,
      default: null,
    },

    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },

    createdAtEbay: {
      type: Date,
      default: null,
    },

    total: {
      type: Number,
      default: 0,
    },

    currency: {
      type: String,
      default: "USD",
    },

    items: [
      {
        itemId: String,
        title: String,
        sku: String,
        quantity: Number,
        price: Number,
      },
    ],

    shippingAddress: {
      name: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },

    rawData: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Compound uniqueness per marketplace (see note on `orderId` above).
// NOTE: this index is declared here but not auto-applied to the live
// database — Mongo already has the older single-field unique index on
// `orderId` from before this change. Applying the new compound index and
// retiring the old one is a deliberate, manual, documented migration step
// (see Migration Notes), never executed automatically on server start.
OrderSchema.index({ platform: 1, orderId: 1 }, { unique: true });

module.exports = mongoose.model("Order", OrderSchema);