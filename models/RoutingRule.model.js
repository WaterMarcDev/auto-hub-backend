/**
 * Routing Rule Model
 *
 * Configurable rules that automatically assign conversations
 * to specific users or teams based on the platform.
 *
 * Examples:
 *   Facebook → Sales Team
 *   Amazon → Marketplace Team
 *   WhatsApp → Support Team
 *   Google Ads → Sales Manager
 *   TikTok → Marketing Team
 *
 * Rules are editable from CRM settings and are evaluated in priority order.
 */
const mongoose = require("mongoose");

const RoutingRuleSchema = new mongoose.Schema(
  {
    // ─── Rule Configuration ────────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Rule name is required"],
      trim: true,
    },

    description: {
      type: String,
      default: null,
    },

    // ─── Matching Criteria ─────────────────────────────────────────────
    platform: {
      type: String,
      required: [true, "Platform is required"],
      enum: [
        "facebook", "instagram", "whatsapp", "tiktok",
        "google_ads", "amazon", "ebay", "any",
      ],
      default: "any",
    },

    matchType: {
      type: String,
      enum: ["platform", "keyword", "tag", "priority"],
      default: "platform",
    },

    matchValue: {
      type: String,
      default: null,
    },

    // ─── Priority ──────────────────────────────────────────────────────
    priority: {
      type: Number,
      default: 0,
    },

    // ─── Assignment ────────────────────────────────────────────────────
    assignedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    assignedTeam: {
      type: String,
      default: null,
    },

    // ─── Status ────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ───────────────────────────────────────────────────────────────

RoutingRuleSchema.index({ platform: 1, isActive: 1 });
RoutingRuleSchema.index({ priority: 1 });

module.exports = mongoose.model("RoutingRule", RoutingRuleSchema);