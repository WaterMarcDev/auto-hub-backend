/**
 * Social Lead Controller
 *
 * Thin HTTP layer over services/socialLead.service.js — see that file for
 * the business logic documentation this controller previously held
 * directly.
 */
const socialLeadService = require("../services/socialLead.service");

function handleError(res, error, logPrefix) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  console.error(logPrefix, error);
  res.status(500).json({ success: false, message: error.message });
}

/**
 * GET /api/social-leads
 */
exports.getAll = async (req, res) => {
  try {
    const result = await socialLeadService.getAllLeads(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Get all error:");
  }
};

/**
 * GET /api/social-leads/:id
 */
exports.getById = async (req, res) => {
  try {
    const lead = await socialLeadService.getLeadById(req.params.id);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Get by ID error:");
  }
};

/**
 * PATCH /api/social-leads/:id/status
 */
exports.updateStatus = async (req, res) => {
  try {
    const lead = await socialLeadService.updateStatus(req.params.id, req.body.status, req.user?._id);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Update status error:");
  }
};

/**
 * PATCH /api/social-leads/:id/assign
 */
exports.assignUser = async (req, res) => {
  try {
    const lead = await socialLeadService.assignUser(req.params.id, req.body.userId, req.user?._id);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Assign error:");
  }
};

/**
 * PATCH /api/social-leads/:id/notes
 */
exports.updateNotes = async (req, res) => {
  try {
    const lead = await socialLeadService.updateNotes(req.params.id, req.body.notes);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Update notes error:");
  }
};

/**
 * PATCH /api/social-leads/:id/priority
 */
exports.updatePriority = async (req, res) => {
  try {
    const lead = await socialLeadService.updatePriority(req.params.id, req.body.priority);
    res.json({ success: true, data: lead });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Update priority error:");
  }
};

/**
 * DELETE /api/social-leads/:id
 */
exports.remove = async (req, res) => {
  try {
    await socialLeadService.archiveLead(req.params.id);
    res.json({ success: true, message: "Lead archived" });
  } catch (err) {
    handleError(res, err, "[SOCIAL LEAD] Delete error:");
  }
};
