/**
 * Part Request Service — extracted 1:1 from controllers/PartRequestController.js
 * during the clean-architecture migration. Every rule, message, status
 * code, console.log, and quirk below is intentionally unchanged.
 *
 * PRESERVED QUIRK (not a fix — flagged here for visibility): createRequest()
 * validates `req.body.year` into a 4-digit integer (`parsedYear`) but the
 * original controller never actually used that parsed value — the new
 * PartRequest document is built from `...req.body` directly, so the raw
 * (string) year flows through untouched. Replicated exactly; not "fixed",
 * since this migration must not change existing behavior.
 */
const partRequestRepository = require("../repositories/partRequest.repository");
const auditLogService = require("./auditLog.service");
const { normalizeRequestSource } = require("../utils/requestSources");

function httpError(statusCode, payload) {
  const err = new Error(payload.message);
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function validatePhoneEmail(phone, email) {
  if (!phone && !email) {
    throw httpError(400, { success: false, message: "Either phone or email is required" });
  }
  if (phone && !/^[0-9]{10}$/.test(phone)) {
    throw httpError(400, { success: false, message: "Phone number must be 10 digits" });
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    throw httpError(400, { success: false, message: "Invalid email format" });
  }
}

function validateYear(year) {
  if (!year) return null;
  const yearStr = year.toString().trim();
  if (!/^\d{4}$/.test(yearStr)) {
    throw httpError(400, { success: false, message: "Year must be exactly 4 digits" });
  }
  return parseInt(yearStr, 10);
}

async function createRequest(body) {
  const { phone, email } = body;

  validatePhoneEmail(phone, email);

  // NOTE: parsedYear is computed (for validation only) but — exactly as in
  // the original controller — never applied to the created document below.
  validateYear(body.year);

  const request = partRequestRepository.build({
    ...body,
    email: body.email || "none", // if email not provided then value will be none
    phone: body.phone || "none", // if phone not provided then value will be none
    source: body.source || "Online", // default value of source
  });

  await partRequestRepository.save(request);
  return request;
}

// Create part request from the AI Chatbot (Automation Bot) — req.user is
// attached by middleware/automationBotAuth.js
async function createAutomationBotRequest(body, user) {
  const { name, phone, email, make, model, year, partName, source } = body;

  validatePhoneEmail(phone, email);
  const parsedYear = validateYear(year);

  const resolvedSource = normalizeRequestSource(source, "Other");

  const request = await partRequestRepository.create({
    name: name || "none",
    phone: phone || "none",
    email: email || "none",
    make,
    model,
    year: parsedYear,
    partName,
    source: resolvedSource,
    createdBy: user._id,
  });

  await auditLogService.logAction({
    action: "lead_created",
    userId: user._id,
    userEmail: user.email,
    platform: resolvedSource,
    entityType: "part_request",
    entityId: request._id,
    message: `Part request created via Automation Bot from ${resolvedSource}`,
  });

  return request;
}

async function getAllRequests() {
  console.log("Before find");
  const requests = await partRequestRepository
    .find()
    .sort({ createdAt: -1 })
    .populate("createdBy", "first_name last_name email role");
  console.log("After fing");
  return requests;
}

async function updatePartRequestSource(id, source) {
  return partRequestRepository.findByIdAndUpdate(id, { source }, { new: true });
}

async function updatePartRequestRemark(id, remark) {
  return partRequestRepository.findByIdAndUpdate(id, { remark }, { new: true });
}

async function updateStatus(id, status) {
  const update = { status };

  // Stamp completedAt exactly once, the first time status becomes
  // "Completed" — later edits (e.g. remark changes) never touch it.
  if (status === "Completed") {
    const existing = await partRequestRepository.findById(id).select("completedAt");
    if (existing && !existing.completedAt) {
      update.completedAt = new Date();
    }
  }

  return partRequestRepository.findByIdAndUpdate(id, update, { new: true });
}

async function deleteRequest(id) {
  const deleted = await partRequestRepository.findByIdAndDelete(id);
  if (!deleted) {
    throw httpError(404, { message: "Request not found" });
  }
}

module.exports = {
  createRequest,
  createAutomationBotRequest,
  getAllRequests,
  updatePartRequestSource,
  updatePartRequestRemark,
  updateStatus,
  deleteRequest,
};
