/**
 * Social Lead Service
 *
 * CRUD business logic for social media leads (Facebook, Instagram,
 * WhatsApp, TikTok, Google Ads). Extracted 1:1 from
 * controllers/socialLead.controller.js during the clean-architecture
 * migration — every rule, message, and status code below is intentionally
 * unchanged.
 */
const socialLeadRepository = require("../repositories/socialLead.repository");
const { logAction } = require("./auditLog.service");

function notFound() {
  const err = new Error("Lead not found");
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getAllLeads(query) {
  const { platform, status, priority, assignedUser, search, page = 1, limit = 50 } = query;

  const mongoQuery = {};
  if (platform) mongoQuery.platform = platform;
  if (status) mongoQuery.conversationStatus = status;
  if (priority) mongoQuery.priority = priority;
  if (assignedUser) mongoQuery.assignedUser = assignedUser;

  if (search) {
    mongoQuery.$or = [
      { customerName: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { lastMessage: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const total = await socialLeadRepository.countDocuments(mongoQuery);

  const leads = await socialLeadRepository
    .find(mongoQuery)
    .populate("assignedUser", "firstName lastName email")
    .populate("customerId", "firstName lastName email mobileNo")
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

  return {
    data: leads,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
  };
}

async function getLeadById(id) {
  const lead = await socialLeadRepository
    .findById(id)
    .populate("assignedUser", "firstName lastName email")
    .populate("customerId", "firstName lastName email mobileNo")
    .lean();

  if (!lead) throw notFound();
  return lead;
}

async function updateStatus(id, status, userId) {
  const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

  if (!validStatuses.includes(status)) {
    throw badRequest("Invalid status");
  }

  const lead = await socialLeadRepository.findByIdAndUpdate(id, { conversationStatus: status }, { new: true });
  if (!lead) throw notFound();

  await logAction({
    action: "lead_updated",
    status: "success",
    platform: lead.platform,
    entityType: "social_lead",
    entityId: lead._id,
    message: `Social lead status updated to ${status}`,
    userId,
  });

  return lead;
}

async function assignUser(id, userIdToAssign, actingUserId) {
  const lead = await socialLeadRepository
    .findByIdAndUpdate(id, { assignedUser: userIdToAssign || null }, { new: true })
    .populate("assignedUser", "firstName lastName email");

  if (!lead) throw notFound();

  await logAction({
    action: "lead_assigned",
    status: "success",
    platform: lead.platform,
    entityType: "social_lead",
    entityId: lead._id,
    message: `Social lead assigned to user ${userIdToAssign}`,
    userId: actingUserId,
  });

  return lead;
}

async function updateNotes(id, notes) {
  const lead = await socialLeadRepository.findByIdAndUpdate(id, { notes }, { new: true });
  if (!lead) throw notFound();
  return lead;
}

async function updatePriority(id, priority) {
  const validPriorities = ["low", "medium", "high", "urgent"];
  if (!validPriorities.includes(priority)) {
    throw badRequest("Invalid priority");
  }

  const lead = await socialLeadRepository.findByIdAndUpdate(id, { priority }, { new: true });
  if (!lead) throw notFound();
  return lead;
}

async function archiveLead(id) {
  const lead = await socialLeadRepository.findByIdAndUpdate(id, { conversationStatus: "archived" }, { new: true });
  if (!lead) throw notFound();
}

module.exports = {
  getAllLeads,
  getLeadById,
  updateStatus,
  assignUser,
  updateNotes,
  updatePriority,
  archiveLead,
};
