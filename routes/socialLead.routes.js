const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/socialLead.controller");

// GET /api/social-leads - List all social leads
router.get("/", auth, controller.getAll);

// GET /api/social-leads/:id - Get single lead
router.get("/:id", auth, controller.getById);

// PATCH /api/social-leads/:id/status - Update status
router.patch("/:id/status", auth, controller.updateStatus);

// PATCH /api/social-leads/:id/assign - Assign user
router.patch("/:id/assign", auth, controller.assignUser);

// PATCH /api/social-leads/:id/notes - Update notes
router.patch("/:id/notes", auth, controller.updateNotes);

// PATCH /api/social-leads/:id/priority - Update priority
router.patch("/:id/priority", auth, controller.updatePriority);

// DELETE /api/social-leads/:id - Archive lead
router.delete("/:id", auth, controller.remove);

module.exports = router;