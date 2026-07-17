/**
 * Social Lead Model
 *
 * Represents a customer lead that originated from a social media platform
 * (Facebook, Instagram, WhatsApp, TikTok, Google Ads).
 *
 * Each lead is auto-created when a new conversation thread is detected
 * from a connected social platform. Smart matching prevents duplicates
 * by checking phone, email, and platform user ID against existing customers.
 *
 * Structure mirrors the Part Request model for consistent UI rendering.
 */
const mongoose = require("mongoose");

const SocialLeadSchema = new mongoose.Schema(
  {
    // ─── Platform Identification ──────────────────────────────────────
    platform: {
      type: String,
      required: [true, "Platform is required"],
      enum: ["facebook", "instagram", "whatsapp", "tiktok", "google_ads"],
      lowercase: true,
      trim: true,
    },

    platformUserId: {
      type: String,
      default: null,
      index: true,
    },

    platformConversationId: {
      type: String,
      default: null,
      index: true,
    },

    platformPageId: {
      type: String,
      default: null,
    },

    // ─── Customer Information ─────────────────────────────────────────
    customerName: {
      type: String,
      default: null,
      trim: true,
    },

    profilePicture: {
      type: String,
      default: null,
    },

    phone: {
      type: String,
      default: null,
      trim: true,
    },

    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },

    language: {
      type: String,
      default: "en",
    },

    country: {
      type: String,
      default: null,
    },

    // ─── CRM Customer Link ────────────────────────────────────────────
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
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

    leadStatus: {
      type: String,
      enum: ["new", "contacted", "qualified", "converted", "lost"],
      default: "new",
    },

    // ─── Notes & Attachments ──────────────────────────────────────────
    notes: {
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

    // ─── Source Tracking ──────────────────────────────────────────────
    source: {
      type: String,
      default: null,
    },

    // ─── Routing ──────────────────────────────────────────────────────
    routingRule: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoutingRule",
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

SocialLeadSchema.index({ platform: 1, conversationStatus: 1 });
SocialLeadSchema.index({ assignedUser: 1 });
SocialLeadSchema.index({ customerId: 1 });
SocialLeadSchema.index({ platformUserId: 1, platform: 1 });
SocialLeadSchema.index({ createdAt: -1 });
SocialLeadSchema.index({ phone: 1 });
SocialLeadSchema.index({ email: 1 });
SocialLeadSchema.index({ priority: 1 });
SocialLeadSchema.index({ tags: 1 });

module.exports = mongoose.model("SocialLead", SocialLeadSchema);