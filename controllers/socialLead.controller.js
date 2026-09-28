/**
 * Social Lead Controller
 *
 * CRUD operations for social media leads (Facebook, Instagram,
 * WhatsApp, TikTok, Google Ads).
 *
 * Mirrors the Part Request controller pattern for consistent UI.
 */
const SocialLead = require("../models/SocialLead.model");
const { logAction } = require("../services/auditLog.service");

/**
 * GET /api/social-leads
 * Fetch all social leads with optional filters.
 */
exports.getAll = async (req, res) => {
  try {
    const {
      platform,
      status,
      priority,
      assignedUser,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (platform) query.platform = platform;
    if (status) query.conversationStatus = status;
    if (priority) query.priority = priority;
    if (assignedUser) query.assignedUser = assignedUser;

    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { lastMessage: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await SocialLead.countDocuments(query);

    const leads = await SocialLead.find(query)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: leads,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("[SOCIAL LEAD] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/social-leads/:id
 * Fetch a single social lead by ID.
 */
exports.getById = async (req, res) => {
  try {
    const lead = await SocialLead.findById(req.params.id)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .lean();

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[SOCIAL LEAD] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/social-leads/:id/status
 * Update conversation status.
 */
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const lead = await SocialLead.findByIdAndUpdate(
      req.params.id,
      { conversationStatus: status },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    await logAction({
      action: "lead_updated",
      status: "success",
      platform: lead.platform,
      entityType: "social_lead",
      entityId: lead._id,
      message: `Social lead status updated to ${status}`,
      userId: req.user?._id,
    });

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[SOCIAL LEAD] Update status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/social-leads/:id/assign
 * Assign a user to the lead.
 */
exports.assignUser = async (req, res) => {
  try {
    const { userId } = req.body;

    const lead = await SocialLead.findByIdAndUpdate(
      req.params.id,
      { assignedUser: userId || null },
      { new: true }
    ).populate("assignedUser", "firstName lastName email");

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    await logAction({
      action: "lead_assigned",
      status: "success",
      platform: lead.platform,
      entityType: "social_lead",
      entityId: lead._id,
      message: `Social lead assigned to user ${userId}`,
      userId: req.user?._id,
    });

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[SOCIAL LEAD] Assign error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/social-leads/:id/notes
 * Update internal notes.
 */
exports.updateNotes = async (req, res) => {
  try {
    const { notes } = req.body;

    const lead = await SocialLead.findByIdAndUpdate(
      req.params.id,
      { notes },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[SOCIAL LEAD] Update notes error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/social-leads/:id/priority
 * Update priority.
 */
exports.updatePriority = async (req, res) => {
  try {
    const { priority } = req.body;
    const validPriorities = ["low", "medium", "high", "urgent"];

    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, message: "Invalid priority" });
    }

    const lead = await SocialLead.findByIdAndUpdate(
      req.params.id,
      { priority },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    console.error("[SOCIAL LEAD] Update priority error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/social-leads/:id
 * Soft delete a lead.
 */
exports.remove = async (req, res) => {
  try {
    const lead = await SocialLead.findByIdAndUpdate(
      req.params.id,
      { conversationStatus: "archived" },
      { new: true }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.json({ success: true, message: "Lead archived" });
  } catch (err) {
    console.error("[SOCIAL LEAD] Delete error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};