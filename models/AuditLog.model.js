/**
 * Audit Log Model
 *
 * Records every significant action across the Socials & Marketplace module.
 *
 * This provides a complete audit trail for debugging, compliance,
 * and monitoring purposes.
 *
 * Each log entry captures:
 *   - What action was performed
 *   - Who performed it
 *   - Which platform/entity was involved
 *   - Whether it succeeded or failed
 *   - Detailed metadata for debugging
 */
const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema(
  {
    // ─── Action Identification ─────────────────────────────────────────
    action: {
      type: String,
      required: [true, "Action is required"],
      enum: [
        "message_sent",
        "message_received",
        "message_delivered",
        "message_read",
        "message_failed",
        "conversation_created",
        "conversation_assigned",
        "conversation_closed",
        "conversation_reopened",
        "lead_created",
        "lead_updated",
        "lead_assigned",
        "platform_connected",
        "platform_disconnected",
        "platform_error",
        "token_refreshed",
        "token_expired",
        "webhook_received",
        "webhook_verified",
        "webhook_failed",
        "webhook_retry",
        "translation_requested",
        "customer_matched",
        "customer_created",
        "order_synced",
        "order_updated",
        "api_error",
        "rate_limit_hit",
        "system_error",
      ],
      required: true,
    },

    // ─── Status ────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["success", "failure", "pending", "warning"],
      default: "success",
    },

    // ─── User ──────────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    userEmail: {
      type: String,
      default: null,
    },

    // ─── Platform ──────────────────────────────────────────────────────
    platform: {
      type: String,
      default: null,
    },

    // ─── Entity References ─────────────────────────────────────────────
    entityType: {
      type: String,
      enum: ["social_lead", "marketplace_lead", "conversation", "integration_account", "customer", "order", "message", "part_request"],
      default: null,
    },

    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // ─── Details ───────────────────────────────────────────────────────
    message: {
      type: String,
      default: null,
    },

    errorMessage: {
      type: String,
      default: null,
    },

    errorStack: {
      type: String,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ─── IP & Request Info ─────────────────────────────────────────────
    ipAddress: {
      type: String,
      default: null,
    },

    userAgent: {
      type: String,
      default: null,
    },

    // ─── Duration ──────────────────────────────────────────────────────
    durationMs: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ───────────────────────────────────────────────────────────────

AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ platform: 1, createdAt: -1 });
AuditLogSchema.index({ userId: 1, createdAt: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1 });
AuditLogSchema.index({ status: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 });

// TTL index: auto-delete logs older than 90 days
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);