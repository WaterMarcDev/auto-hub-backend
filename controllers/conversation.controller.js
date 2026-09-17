/**
 * Conversation Controller
 *
 * Unified inbox controller for managing conversations across all platforms.
 *
 * Handles:
 *   - Fetching conversations with filters
 *   - Sending replies to any platform
 *   - Internal notes (never sent to customer)
 *   - Conversation status management
 *   - Assignment management
 */
const conversationService = require("../services/conversation.service");

function handleError(res, err, label) {
  console.error(`[CONVERSATION] ${label}:`, err);
  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }
  return res.status(500).json({ success: false, message: err.message });
}

/**
 * GET /api/conversations
 * Fetch all conversations with filters.
 */
exports.getAll = async (req, res) => {
  try {
    const result = await conversationService.getAll(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "Get all error");
  }
};

/**
 * GET /api/conversations/:id
 * Fetch a single conversation with all messages.
 */
exports.getById = async (req, res) => {
  try {
    const conversation = await conversationService.getById(req.params.id);
    res.json({ success: true, data: conversation });
  } catch (err) {
    handleError(res, err, "Get by ID error");
  }
};

/**
 * POST /api/conversations/:id/reply
 * Send a reply on behalf of an agent.
 */
exports.sendReply = async (req, res) => {
  try {
    const { conversation, result } = await conversationService.sendReply(req.params.id, req.body, req.user);

    // Real-time push so the Unified Inbox shows the agent's own reply
    // instantly, without waiting on a poll. Mirrors the existing
    // `new_email` Socket.io pattern (controllers/email.controller.js) —
    // purely additive, never affects the HTTP response below.
    const io = req.app.get("io");
    if (io) {
      const lastMsg = conversation.messages[conversation.messages.length - 1];
      io.emit("new_message", {
        conversationId: conversation._id,
        message: lastMsg,
        conversation: {
          _id: conversation._id,
          platform: conversation.platform,
          customerName: conversation.customerName,
          lastMessage: conversation.lastMessage,
          lastMessageAt: conversation.lastMessageAt,
          unreadCount: conversation.unreadCount,
          status: conversation.status,
        },
      });
    }

    res.json({
      success: true,
      message: "Reply sent successfully",
      data: {
        platformMessageId: result.platformMessageId,
        messageCount: conversation.messageCount,
      },
    });
  } catch (err) {
    console.error("[CONVERSATION] Reply error:", err);

    await conversationService.logReplyFailure({
      action: "message_failed",
      status: "failure",
      platform: req.params.platform,
      entityType: "conversation",
      entityId: req.params.id,
      message: `Failed to send reply: ${err.message}`,
      errorMessage: err.message,
      userId: req.user?._id,
    });

    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/conversations/:id/notes
 * Add an internal note (never sent to customer).
 */
exports.addInternalNote = async (req, res) => {
  try {
    const { text } = req.body;
    const internalNotes = await conversationService.addInternalNote(req.params.id, text, req.user?._id);
    res.json({ success: true, data: internalNotes });
  } catch (err) {
    handleError(res, err, "Add note error");
  }
};

/**
 * PATCH /api/conversations/:id/status
 * Update conversation status.
 */
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const conversation = await conversationService.updateStatus(req.params.id, status);
    res.json({ success: true, data: conversation });
  } catch (err) {
    handleError(res, err, "Update status error");
  }
};

/**
 * PATCH /api/conversations/:id/assign
 * Assign/reassign conversation to a user.
 */
exports.assignUser = async (req, res) => {
  try {
    const { userId } = req.body;
    const conversation = await conversationService.assignUser(req.params.id, userId);
    res.json({ success: true, data: conversation });
  } catch (err) {
    handleError(res, err, "Assign error");
  }
};

/**
 * PATCH /api/conversations/:id/tags
 * Update conversation tags.
 */
exports.updateTags = async (req, res) => {
  try {
    const { tags } = req.body;
    const conversation = await conversationService.updateTags(req.params.id, tags);
    res.json({ success: true, data: conversation });
  } catch (err) {
    handleError(res, err, "Update tags error");
  }
};

/**
 * GET /api/conversations/:id/messages
 * Paginated message history for a conversation.
 */
exports.getMessages = async (req, res) => {
  try {
    const result = await conversationService.getMessages(req.params.id, req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err, "Get messages error");
  }
};
