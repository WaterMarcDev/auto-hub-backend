/**
 * Audit Log Service
 *
 * Provides a centralized logging interface for all significant actions
 * across the Socials & Marketplace module.
 *
 * Every action is recorded in the AuditLog collection with:
 *   - Action type
 *   - Success/failure status
 *   - User who performed it
 *   - Platform involved
 *   - Entity reference
 *   - Detailed metadata
 *
 * TTL index automatically deletes logs older than 90 days.
 */
const AuditLog = require("../models/auditLog.model");

/**
 * Log an action to the audit trail.
 *
 * @param {Object} params
 * @param {string} params.action - Action type (must be in enum)
 * @param {string} [params.status='success'] - 'success', 'failure', 'pending', 'warning'
 * @param {ObjectId} [params.userId] - User who performed the action
 * @param {string} [params.userEmail] - User email for quick reference
 * @param {string} [params.platform] - Platform involved
 * @param {string} [params.entityType] - Type of entity (social_lead, marketplace_lead, etc.)
 * @param {ObjectId} [params.entityId] - Entity ID
 * @param {string} [params.message] - Human-readable description
 * @param {string} [params.errorMessage] - Error message if failed
 * @param {string} [params.errorStack] - Error stack trace if failed
 * @param {Object} [params.metadata] - Additional metadata
 * @param {string} [params.ipAddress] - IP address of requester
 * @param {string} [params.userAgent] - User agent of requester
 * @param {number} [params.durationMs] - How long the operation took
 * @returns {Promise<Object>} Created audit log entry
 */
async function logAction(params) {
  try {
    const entry = {
      action: params.action,
      status: params.status || "success",
      userId: params.userId || null,
      userEmail: params.userEmail || null,
      platform: params.platform || null,
      entityType: params.entityType || null,
      entityId: params.entityId || null,
      message: params.message || null,
      errorMessage: params.errorMessage || null,
      errorStack: params.errorStack || null,
      metadata: params.metadata || {},
      ipAddress: params.ipAddress || null,
      userAgent: params.userAgent || null,
      durationMs: params.durationMs || null,
    };

    return await AuditLog.create(entry);
  } catch (err) {
    // Never throw — audit logging should never break the main flow
    console.error("[AUDIT] Failed to log action:", err.message);
    return null;
  }
}

/**
 * Fetch recent audit logs with optional filters.
 *
 * @param {Object} [filters={}]
 * @param {string} [filters.action] - Filter by action type
 * @param {string} [filters.status] - Filter by status
 * @param {string} [filters.platform] - Filter by platform
 * @param {ObjectId} [filters.userId] - Filter by user
 * @param {string} [filters.entityType] - Filter by entity type
 * @param {ObjectId} [filters.entityId] - Filter by entity ID
 * @param {number} [filters.limit=50] - Max results
 * @param {number} [filters.skip=0] - Pagination offset
 * @returns {Promise<Array>} Array of audit log entries
 */
async function getLogs(filters = {}) {
  const query = {};

  if (filters.action) query.action = filters.action;
  if (filters.status) query.status = filters.status;
  if (filters.platform) query.platform = filters.platform;
  if (filters.userId) query.userId = filters.userId;
  if (filters.entityType) query.entityType = filters.entityType;
  if (filters.entityId) query.entityId = filters.entityId;

  const limit = Math.min(filters.limit || 50, 200);
  const skip = filters.skip || 0;

  return await AuditLog.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

module.exports = {
  logAction,
  getLogs,
};