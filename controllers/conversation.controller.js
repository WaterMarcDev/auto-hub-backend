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
 *   - Translation
 */
const Conversation = require("../models/Conversation.model");
const SocialLead = require("../models/SocialLead.model");
const MarketplaceLead = require("../models/MarketplaceLead.model");
const platformManager = require("../services/platformManager.service");
const translationService = require("../services/translation.service");
const { logAction } = require("../services/auditLog.service");

/**
 * GET /api/conversations
 * Fetch all conversations with filters.
 */
exports.getAll = async (req, res) => {
  try {
    const {
      platform,
      status,
      assignedUser,
      customerId,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (platform) query.platform = platform;
    if (status) query.status = status;
    if (assignedUser) query.assignedUser = assignedUser;
    if (customerId) query.customerId = customerId;

    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: "i" } },
        { lastMessage: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Conversation.countDocuments(query);

    const conversations = await Conversation.find(query)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: conversations,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("[CONVERSATION] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/conversations/:id
 * Fetch a single conversation with all messages.
 */
exports.getById = async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id)
      .populate("assignedUser", "firstName lastName email")
      .populate("customerId", "firstName lastName email mobileNo")
      .lean();

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    res.json({ success: true, data: conversation });
  } catch (err) {
    console.error("[CONVERSATION] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/conversations/:id/reply
 * Send a reply on behalf of an agent.
 */
exports.sendReply = async (req, res) => {
  try {
    const { text, attachments = [] } = req.body;
    const conversation = await Conversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, message: "Message text or attachments required" });
    }

    // Send via Platform Manager
    const result = await platformManager.sendMessage(
      conversation.platform,
      conversation,
      text,
      attachments,
      {}
    );

    // Add message to conversation
    conversation.messages.push({
      platformMessageId: result.platformMessageId,
      senderType: "agent",
      senderId: req.user?._id || null,
      senderName: req.user ? `${req.user.firstName} ${req.user.lastName}`.trim() : "System",
      text,
      messageType: attachments.length > 0 ? "document" : "text",
      attachments: attachments.map((a) => ({
        url: a.url,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
      deliveryStatus: result.status || "sent",
      deliveredAt: new Date(),
    });

    // Update conversation status
    conversation.status = "open";
    conversation.unreadCount = 0;
    await conversation.save();

    // Update lead unread count
    if (conversation.socialLeadId) {
      await SocialLead.findByIdAndUpdate(conversation.socialLeadId, {
        conversationStatus: "open",
        unreadCount: 0,
        lastMessage: text,
        lastMessageAt: new Date(),
      });
    } else if (conversation.marketplaceLeadId) {
      await MarketplaceLead.findByIdAndUpdate(conversation.marketplaceLeadId, {
        conversationStatus: "open",
        unreadCount: 0,
        lastMessage: text,
        lastMessageAt: new Date(),
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

    // Log the failure
    await logAction({
      action: "message_failed",
      status: "failure",
      platform: req.params.platform,
      entityType: "conversation",
      entityId: req.params.id,
      message: `Failed to send reply: ${err.message}`,
      errorMessage: err.message,
      userId: req.user?._id,
    });

    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/conversations/:id/translate
 * Translate a specific message.
 */
exports.translateMessage = async (req, res) => {
  try {
    const { messageId, targetLanguage = "en" } = req.body;
    const conversation = await Conversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const message = conversation.messages.id(messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    const result = await translationService.translateToEnglish(
      message.originalText || message.text,
      message.originalLanguage
    );

    res.json({
      success: true,
      data: {
        originalText: message.originalText || message.text,
        originalLanguage: result.originalLanguage,
        translatedText: result.translatedText,
      },
    });
  } catch (err) {
    console.error("[CONVERSATION] Translate error:", err);
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

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: "Note text is required" });
    }

    const conversation = await Conversation.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          internalNotes: {
            text: text.trim(),
            createdBy: req.user?._id || null,
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    ).populate("internalNotes.createdBy", "firstName lastName email");

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    res.json({ success: true, data: conversation.internalNotes });
  } catch (err) {
    console.error("[CONVERSATION] Add note error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/conversations/:id/status
 * Update conversation status.
 */
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const conversation = await Conversation.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    res.json({ success: true, data: conversation });
  } catch (err) {
    console.error("[CONVERSATION] Update status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/conversations/:id/assign
 * Assign/reassign conversation to a user.
 */
exports.assignUser = async (req, res) => {
  try {
    const { userId } = req.body;

    const conversation = await Conversation.findByIdAndUpdate(
      req.params.id,
      { assignedUser: userId || null },
      { new: true }
    ).populate("assignedUser", "firstName lastName email");

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    res.json({ success: true, data: conversation });
  } catch (err) {
    console.error("[CONVERSATION] Assign error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/conversations/:id/tags
 * Update conversation tags.
 */
exports.updateTags = async (req, res) => {
  try {
    const { tags } = req.body;

    const conversation = await Conversation.findByIdAndUpdate(
      req.params.id,
      { tags: tags || [] },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    res.json({ success: true, data: conversation });
  } catch (err) {
    console.error("[CONVERSATION] Update tags error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/conversations/:id/messages
 * Paginated message history for a conversation.
 */
exports.getMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    console.log("======== GET MESSAGES =========");
    console.log("Conversation ID:", req.params.id);

    const conversation = await Conversation.findById(req.params.id)
      .select("messages")
      .lean();
    
      console.log("Conversation Found:", conversation);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    // Reverse for newest-first pagination
    const totalMessages = conversation.messages.length;
    const messages = conversation.messages
      .slice(-(skip + parseInt(limit)))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      data: messages,
      pagination: {
        total: totalMessages,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(totalMessages / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("[CONVERSATION] Get messages error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};