/**
 * Conversation (Unified Inbox) business logic. Extracted 1:1 from
 * controllers/conversation.controller.js during the clean-architecture
 * migration — every filter, message-append shape, and lead-unread-count
 * side effect is preserved exactly.
 *
 * NOTE: `getMessageTime`/`sortMessagesChronologically` are confirmed
 * pre-existing dead code — defined in the original controller with a
 * detailed doc comment describing intended chronological sorting, but
 * never actually called anywhere (not even by getMessages(), which the
 * comment implies it should serve). Preserved here exactly as unused,
 * unwired code rather than "fixed" by actually applying it — this
 * migration's scope is structural only.
 */
const mongoose = require("mongoose");
const conversationRepository = require("../repositories/conversation.repository");
const socialLeadRepository = require("../repositories/socialLead.repository");
const marketplaceListingRepository = require("../repositories/marketplaceListing.repository");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Resolve the authoritative time for a message subdocument, for sorting
 * strictly oldest -> newest. `createdAt` already holds the real timestamp
 * for every message (the platform's own timestamp for synced messages —
 * see services/adapters/ebayAdapter.js#_upsertMessage — or the server
 * send-time for CRM replies), so no new field/schema is needed; this only
 * reads what already exists.
 *
 * Never throws: legacy/malformed messages with no usable createdAt fall
 * back to the timestamp embedded in their own Mongo ObjectId (still a real,
 * monotonic creation time), and finally to 0 rather than crashing.
 *
 * @param {Object} message - message subdocument (plain object, from .lean())
 * @returns {number} epoch milliseconds
 */
function getMessageTime(message) {
  if (message?.createdAt) {
    const time = new Date(message.createdAt).getTime();
    if (!Number.isNaN(time)) return time;
  }

  if (message?._id) {
    try {
      return new mongoose.Types.ObjectId(message._id).getTimestamp().getTime();
    } catch {
      // fall through to 0 below
    }
  }

  return 0;
}

/**
 * Sort message subdocuments strictly oldest -> newest by their
 * authoritative timestamp, without mutating the input array or touching
 * anything in the database — insertion order (which can diverge from
 * chronological order, e.g. a later historical sync backfilling older
 * messages after a live reply was already appended) is never relied upon.
 *
 * @param {Array<Object>} messages
 * @returns {Array<Object>} new, sorted array
 */
function sortMessagesChronologically(messages) {
  if (!Array.isArray(messages)) return messages;
  return [...messages].sort((a, b) => getMessageTime(a) - getMessageTime(b));
}

async function getAll(query) {
  const { platform, status, assignedUser, customerId, search, page = 1, limit = 50 } = query;

  const filter = {};

  if (platform) filter.platform = platform;
  if (status) filter.status = status;
  if (assignedUser) filter.assignedUser = assignedUser;
  if (customerId) filter.customerId = customerId;

  if (search) {
    filter.$or = [
      { customerName: { $regex: search, $options: "i" } },
      { lastMessage: { $regex: search, $options: "i" } },
      { tags: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const total = await conversationRepository.countDocuments(filter);

  const conversations = await conversationRepository
    .find(filter)
    .populate("assignedUser", "firstName lastName email")
    .populate("customerId", "firstName lastName email mobileNo")
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

  return {
    data: conversations,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
  };
}

async function getById(id) {
  const conversation = await conversationRepository
    .findById(id)
    .populate("assignedUser", "firstName lastName email")
    .populate("customerId", "firstName lastName email mobileNo")
    .lean();

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }
  return conversation;
}

/**
 * Sends a reply, appends it to the conversation, and updates lead unread
 * counts. Returns the saved conversation (so the controller can still emit
 * the Socket.io event using the up-to-date in-memory document) plus the
 * platform send result.
 */
async function sendReply(id, body, user) {
  const { text, attachments = [] } = body;
  const conversation = await conversationRepository.findById(id);

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }

  if (!text && attachments.length === 0) {
    throw badRequestError("Message text or attachments required");
  }

  const result = await platformManager.sendMessage(conversation.platform, conversation, text, attachments, {});

  conversation.messages.push({
    platformMessageId: result.platformMessageId,
    senderType: "agent",
    senderId: user?._id || null,
    senderName: user ? `${user.firstName} ${user.lastName}`.trim() : "System",
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

  conversation.status = "open";
  conversation.unreadCount = 0;
  await conversationRepository.save(conversation);

  if (conversation.socialLeadId) {
    await socialLeadRepository.findByIdAndUpdate(conversation.socialLeadId, {
      conversationStatus: "open",
      unreadCount: 0,
      lastMessage: text,
      lastMessageAt: new Date(),
    });
  } else if (conversation.marketplaceLeadId) {
    await marketplaceListingRepository.findByIdAndUpdate(conversation.marketplaceLeadId, {
      conversationStatus: "open",
      unreadCount: 0,
      lastMessage: text,
      lastMessageAt: new Date(),
    });
  }

  return { conversation, result };
}

async function logReplyFailure(params) {
  await logAction(params);
}

async function addInternalNote(id, text, userId) {
  if (!text || !text.trim()) {
    throw badRequestError("Note text is required");
  }

  const conversation = await conversationRepository
    .findByIdAndUpdate(
      id,
      { $push: { internalNotes: { text: text.trim(), createdBy: userId || null, createdAt: new Date() } } },
      { new: true }
    )
    .populate("internalNotes.createdBy", "firstName lastName email");

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }

  return conversation.internalNotes;
}

async function updateStatus(id, status) {
  const validStatuses = ["new", "open", "in_progress", "waiting_customer", "waiting_internal", "resolved", "closed", "archived"];

  if (!validStatuses.includes(status)) {
    throw badRequestError("Invalid status");
  }

  const conversation = await conversationRepository.findByIdAndUpdate(id, { status }, { new: true });

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }

  return conversation;
}

async function assignUser(id, userId) {
  const conversation = await conversationRepository
    .findByIdAndUpdate(id, { assignedUser: userId || null }, { new: true })
    .populate("assignedUser", "firstName lastName email");

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }

  return conversation;
}

async function updateTags(id, tags) {
  const conversation = await conversationRepository.findByIdAndUpdate(id, { tags: tags || [] }, { new: true });

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }

  return conversation;
}

async function getMessages(id, query) {
  const { page = 1, limit = 50 } = query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  console.log("======== GET MESSAGES =========");
  console.log("Conversation ID:", id);

  const conversation = await conversationRepository.findById(id).select("messages").lean();

  console.log("Conversation Found:", conversation);

  if (!conversation) {
    throw notFoundError("Conversation not found");
  }

  // Reverse for newest-first pagination
  const totalMessages = conversation.messages.length;
  const messages = conversation.messages.slice(-(skip + parseInt(limit))).slice(0, parseInt(limit));

  return {
    data: messages,
    pagination: {
      total: totalMessages,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(totalMessages / parseInt(limit)),
    },
  };
}

module.exports = {
  getAll,
  getById,
  sendReply,
  logReplyFailure,
  addInternalNote,
  updateStatus,
  assignUser,
  updateTags,
  getMessages,
};
