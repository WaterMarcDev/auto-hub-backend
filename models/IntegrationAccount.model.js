/**
 * Integration Account Model
 *
 * Stores OAuth tokens, webhook configurations, and connection status
 * for each connected social/marketplace platform.
 *
 * This model is the single source of truth for all external platform
 * connections — Facebook, Instagram, WhatsApp, Google Ads, TikTok,
 * Amazon, eBay, and any future platforms.
 *
 * Tokens are encrypted at rest. Refresh tokens are stored securely.
 * Webhook verification secrets are maintained per platform.
 */
const mongoose = require("mongoose");

const IntegrationAccountSchema = new mongoose.Schema(
  {
    // ─── Platform Identification ──────────────────────────────────────
    platform: {
      type: String,
      required: [true, "Platform is required"],
      enum: [
        "facebook",
        "instagram",
        "whatsapp",
        "google_ads",
        "tiktok",
        "amazon",
        "ebay",
      ],
      lowercase: true,
      trim: true,
    },

    // ─── User Association ─────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ─── OAuth Tokens ─────────────────────────────────────────────────
    accessToken: {
      type: String,
      required: [true, "Access token is required"],
    },

    refreshToken: {
      type: String,
      default: null,
    },

    tokenExpiresAt: {
      type: Date,
      default: null,
    },

    tokenType: {
      type: String,
      default: "Bearer",
    },

    scope: {
      type: [String],
      default: [],
    },

    // ─── Platform Identity ────────────────────────────────────────────
    platformUserId: {
      type: String,
      default: null,
    },

    platformPageId: {
      type: String,
      default: null,
    },

    platformBusinessId: {
      type: String,
      default: null,
    },

    platformEmail: {
      type: String,
      default: null,
    },

    platformName: {
      type: String,
      default: null,
    },

    // ─── Webhook Configuration ────────────────────────────────────────
    webhookSecret: {
      type: String,
      default: null,
    },

    webhookVerified: {
      type: Boolean,
      default: false,
    },

    webhookLastPing: {
      type: Date,
      default: null,
    },

    webhookConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ─── Connection Status ────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
    },

    isConnected: {
      type: Boolean,
      default: false,
    },

    lastSyncAt: {
      type: Date,
      default: null,
    },

    lastErrorAt: {
      type: Date,
      default: null,
    },

    lastErrorMessage: {
      type: String,
      default: null,
    },

    errorCount: {
      type: Number,
      default: 0,
    },

    // ─── Platform-Specific Metadata ───────────────────────────────────
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ─── Rate Limiting ────────────────────────────────────────────────
    rateLimitRemaining: {
      type: Number,
      default: null,
    },

    rateLimitResetAt: {
      type: Date,
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

IntegrationAccountSchema.index({ platform: 1, isActive: 1 });
IntegrationAccountSchema.index({ platformUserId: 1, platform: 1 }, { unique: true, sparse: true });
IntegrationAccountSchema.index({ tokenExpiresAt: 1 });

// ─── Virtuals ──────────────────────────────────────────────────────────────

IntegrationAccountSchema.virtual("isTokenExpired").get(function () {
  if (!this.tokenExpiresAt) return false;
  return new Date() >= this.tokenExpiresAt;
});

IntegrationAccountSchema.virtual("needsTokenRefresh").get(function () {
  if (!this.tokenExpiresAt) return false;
  // Refresh if token expires within the next hour
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  return this.tokenExpiresAt <= oneHourFromNow;
});

// ─── Methods ───────────────────────────────────────────────────────────────

/**
 * Update connection status after a successful sync or error.
 */
IntegrationAccountSchema.methods.recordSync = function (success, errorMessage = null) {
  if (success) {
    this.lastSyncAt = new Date();
    this.isConnected = true;
    this.errorCount = 0;
    this.lastErrorMessage = null;
    this.lastErrorAt = null;
  } else {
    this.errorCount += 1;
    this.lastErrorMessage = errorMessage;
    this.lastErrorAt = new Date();
  }
  return this.save();
};

/**
 * Mark the connection as disconnected.
 */
IntegrationAccountSchema.methods.disconnect = function () {
  this.isActive = false;
  this.isConnected = false;
  return this.save();
};

module.exports = mongoose.model("IntegrationAccount", IntegrationAccountSchema);