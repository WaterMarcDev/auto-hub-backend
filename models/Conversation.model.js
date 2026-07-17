/**
 * Conversation Model
 *
 * Represents a persistent conversation thread between a customer
 * and the business on any connected platform.
 *
 * One conversation per customer per platform.
 * Messages are stored as an array of subdocuments for efficient
 * pagination and real-time updates.
 *
 * Supports:
 *   - Text, images, videos, documents, voice messages
 *   - Delivery status, read receipts
 *   - Internal notes (never sent to customer)
 *   - Translation preservation (original + translated)
 *   - Typing indicators (optional)
 */
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    // ─── Message Identity ───────────────────────────────────────────
    platformMessageId: {
      type: String,
      default: null,
    },

    // ─── Sender ─────────────────────────────────────────────────────
    senderType: {
      type: String,
      enum: ["customer", "agent", "system"],
      required: true,
    },

    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    senderName: {
      type: String,
      default: null,
    },

    // ─── Content ────────────────────────────────────────────────────
    text: {
      type: String,
      default: null,
    },

    messageType: {
      type: String,
      enum: [
        "text", "image", "video", "audio", "document",
        "sticker", "emoji", "quick_reply", "template",
        "button", "contact", "location", "system",
      ],
      default: "text",
    },

    // ─── Attachments ────────────────────────────────────────────────
    attachments: [
      {
        url: { type: String, required: true },
        filename: { type: String, default: null },
        mimeType: { type: String, default: null },
        size: { type: Number, default: null },
        thumbnailUrl: { type: String, default: null },
      },
    ],

    // ─── Translation ───────────────────────────────────────────────
    originalText: {
      type: String,
      default: null,
    },

    originalLanguage: {
      type: String,
      default: null,
    },

    translatedText: {
      type: String,
      default: null,
    },

    // ─── Status ─────────────────────────────────────────────────────
    deliveryStatus: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed"],
      default: "pending",
    },

    readAt: {
      type: Date,
      default: null,
    },

    deliveredAt: {
      type: Date,
      default: null,
    },

    // ─── Metadata ──────────────────────────────────────────────────
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

const ConversationSchema = new mongoose.Schema(
  {
    // ─── Platform Identification ──────────────────────────────────────
    platform: {
      type: String,
      required: [true, "Platform is required"],
      enum: [
        "facebook", "instagram", "whatsapp", "tiktok",
        "google_ads", "amazon", "ebay",
      ],
      lowercase: true,
      trim: true,
    },

    platformConversationId: {
      type: String,
      default: null,
      index: true,
    },

    platformUserId: {
      type: String,
      default: null,
    },

    platformPageId: {
      type: String,
      default: null,
    },

    // ─── Lead References ──────────────────────────────────────────────
    socialLeadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SocialLead",
      default: null,
    },

    marketplaceLeadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MarketplaceLead",
      default: null,
    },

    // ─── Customer Reference ───────────────────────────────────────────
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },

    customerName: {
      type: String,
      default: null,
    },

    customerProfilePicture: {
      type: String,
      default: null,
    },

    // ─── Messages ─────────────────────────────────────────────────────
    messages: [MessageSchema],

    messageCount: {
      type: Number,
      default: 0,
    },

    lastMessage: {
      type: String,
      default: null,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    // ─── Status ───────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"],
      default: "new",
    },

    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    unreadCount: {
      type: Number,
      default: 0,
    },

    // ─── Internal Notes ───────────────────────────────────────────────
    internalNotes: [
      {
        text: { type: String, required: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // ─── Tags ─────────────────────────────────────────────────────────
    tags: {
      type: [String],
      default: [],
    },

    // ─── Priority ─────────────────────────────────────────────────────
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ───────────────────────────────────────────────────────────────

ConversationSchema.index({ platform: 1, platformConversationId: 1 }, { unique: true, sparse: true });
ConversationSchema.index({ customerId: 1 });
ConversationSchema.index({ assignedUser: 1, status: 1 });
ConversationSchema.index({ status: 1, lastMessageAt: -1 });
ConversationSchema.index({ platform: 1, status: 1 });
ConversationSchema.index({ "messages.platformMessageId": 1 }, { sparse: true });
ConversationSchema.index({ updatedAt: -1 });

// ─── Pre-save Hook ─────────────────────────────────────────────────────────

ConversationSchema.pre("save", function (next) {
  this.messageCount = this.messages.length;
  if (this.messages.length > 0) {
    const last = this.messages[this.messages.length - 1];
    this.lastMessage = last.text || `[${last.messageType}]`;
    this.lastMessageAt = last.createdAt || new Date();
  }
  next();
});

module.exports = mongoose.model("Conversation", ConversationSchema);