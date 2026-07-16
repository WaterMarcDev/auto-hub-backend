/**
 * Marketplace Lead Model
 *
 * Represents a customer order or inquiry from an online marketplace
 * (Amazon, eBay, and future platforms like Shopify, Etsy, etc.).
 *
 * Each lead is auto-created when a new order or customer message
 * is detected from a connected marketplace.
 *
 * Smart matching prevents duplicates by checking marketplace order ID,
 * customer email, and phone against existing CRM records.
 */
const mongoose = require("mongoose");

const MarketplaceLeadSchema = new mongoose.Schema(
  {
    // ─── Marketplace Identification ───────────────────────────────────
    marketplace: {
      type: String,
      required: [true, "Marketplace is required"],
      enum: ["amazon", "ebay"],
      lowercase: true,
      trim: true,
    },

    marketplaceOrderId: {
      type: String,
      default: null,
      index: true,
    },

    marketplaceCustomerId: {
      type: String,
      default: null,
    },

    marketplaceListingId: {
      type: String,
      default: null,
    },

    // ─── Customer Information ─────────────────────────────────────────
    customerName: {
      type: String,
      default: null,
      trim: true,
    },

    customerEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },

    customerPhone: {
      type: String,
      default: null,
      trim: true,
    },

    shippingAddress: {
      street: { type: String, default: null },
      city: { type: String, default: null },
      state: { type: String, default: null },
      zip: { type: String, default: null },
      country: { type: String, default: null },
    },

    // ─── CRM Customer Link ────────────────────────────────────────────
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },

    // ─── Order Details ────────────────────────────────────────────────
    productName: {
      type: String,
      default: null,
    },

    productSku: {
      type: String,
      default: null,
    },

    quantity: {
      type: Number,
      default: 1,
    },

    price: {
      type: Number,
      default: 0,
    },

    currency: {
      type: String,
      default: "USD",
    },

    orderStatus: {
      type: String,
      enum: ["pending", "confirmed", "shipped", "delivered", "returned", "refunded", "cancelled", "awaiting_payment", "on_hold"],
      default: "pending",
    },

    shippingStatus: {
      type: String,
      enum: ["not_shipped", "partially_shipped", "shipped", "delivered", "returned", "delayed"],
      default: "not_shipped",
    },

    trackingNumber: {
      type: String,
      default: null,
    },

    carrier: {
      type: String,
      default: null,
    },

    estimatedDelivery: {
      type: Date,
      default: null,
    },

    // ─── Conversation Status ──────────────────────────────────────────
    conversationStatus: {
      type: String,
      enum: ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"],
      default: "new",
    },

    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    lastMessage: {
      type: String,
      default: null,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    unreadCount: {
      type: Number,
      default: 0,
    },

    // ─── Tags, Priority, Lead Status ──────────────────────────────────
    tags: {
      type: [String],
      default: [],
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },

    // ─── Notes & Attachments ──────────────────────────────────────────
    notes: {
      type: String,
      default: null,
    },

    internalNotes: {
      type: String,
      default: null,
    },

    attachments: [
      {
        url: String,
        filename: String,
        type: String,
        size: Number,
      },
    ],

    // ─── Returns & Refunds ────────────────────────────────────────────
    returnRequested: {
      type: Boolean,
      default: false,
    },

    returnReason: {
      type: String,
      default: null,
    },

    refundAmount: {
      type: Number,
      default: null,
    },

    refundStatus: {
      type: String,
      enum: ["none", "requested", "approved", "processed", "rejected"],
      default: "none",
    },

    // ─── Source Tracking ──────────────────────────────────────────────
    source: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ───────────────────────────────────────────────────────────────

MarketplaceLeadSchema.index({ marketplace: 1, orderStatus: 1 });
MarketplaceLeadSchema.index({ marketplaceOrderId: 1, marketplace: 1 }, { unique: true, sparse: true });
MarketplaceLeadSchema.index({ customerId: 1 });
MarketplaceLeadSchema.index({ assignedUser: 1 });
MarketplaceLeadSchema.index({ createdAt: -1 });
MarketplaceLeadSchema.index({ customerEmail: 1 });
MarketplaceLeadSchema.index({ trackingNumber: 1 });
MarketplaceLeadSchema.index({ priority: 1 });

module.exports = mongoose.model("MarketplaceLead", MarketplaceLeadSchema);