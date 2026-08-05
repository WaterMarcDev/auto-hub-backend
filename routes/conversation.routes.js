const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/conversation.controller");

// GET /api/conversations
router.get("/", auth, controller.getAll);

// GET /api/conversations/:id
router.get("/:id", auth, controller.getById);

// GET /api/conversations/:id/messages
router.get("/:id/messages", auth, controller.getMessages);

// POST /api/conversations/:id/reply
router.post("/:id/reply", auth, controller.sendReply);

// POST /api/conversations/:id/translate
router.post("/:id/translate", auth, controller.translateMessage);

// POST /api/conversations/:id/notes
router.post("/:id/notes", auth, controller.addInternalNote);

// PATCH /api/conversations/:id/status
router.patch("/:id/status", auth, controller.updateStatus);

// PATCH /api/conversations/:id/assign
router.patch("/:id/assign", auth, controller.assignUser);

// PATCH /api/conversations/:id/tags
router.patch("/:id/tags", auth, controller.updateTags);

module.exports = router;