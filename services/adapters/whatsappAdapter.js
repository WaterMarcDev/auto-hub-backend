/**
 * WhatsApp Cloud API Adapter
 *
 * Extends MetaAdapter with WhatsApp-specific implementation.
 *
 * WhatsApp-specific logic:
 *   - Message formatting (text, template, interactive, media)
 *   - Phone number ID management
 *   - Incoming message parsing (text, image, video, audio, document, contacts, location, buttons, interactive)
 *   - Status updates (sent, delivered, read, failed)
 *   - Mark as read
 *   - Template message sending
 *
 * All OAuth, token management, webhook registration, and Graph API
 * communication is inherited from MetaAdapter.
 */
const MetaAdapter = require("./metaAdapter");
const { logAction } = require("../auditLog.service");
const Conversation = require("../../models/Conversation.model");
const Customer = require("../../models/customer");
const smartMatch = require("../smartMatch.service");

class WhatsAppAdapter extends MetaAdapter {
  constructor() {
    super("whatsapp", {
      scope: [
        "whatsapp_business_messaging",
        "whatsapp_business_management",
        "business_management",
      ],
    });
  }

  // ─── Phone Number ──────────────────────────────────────────────────────

  /**
   * Fetch phone numbers associated with the WhatsApp Business Account.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<Array<{phoneNumberId: string, displayPhoneNumber: string}>>}
   */
  async fetchPhoneNumber(account) {
    if (!account.platformBusinessId) {
      throw new Error("Business Account ID is required. Call fetchBusinessAccount() first.");
    }

    const result = await this.client.get(
      account.accessToken,
      `/${account.platformBusinessId}/phone_numbers`
    );

    const phoneNumbers = result.data || [];
    if (phoneNumbers.length === 0) {
      throw new Error(
        "No phone numbers found for this WhatsApp Business Account. " +
        "Please add a phone number at https://business.facebook.com/wa/manage/phone-numbers"
      );
    }

    // Use the first verified phone number
    const phone = phoneNumbers[0];
    account.platformPageId = phone.id; // Store phone number ID in platformPageId
    account.platformName = phone.display_phone_number;
    account.metadata = {
      ...account.metadata,
      phoneNumberId: phone.id,
      displayPhoneNumber: phone.display_phone_number,
      phoneNumbers: phoneNumbers.map((p) => ({
        id: p.id,
        displayPhoneNumber: p.display_phone_number,
        verifiedName: p.verified_name,
        codeVerificationStatus: p.code_verification_status,
      })),
    };
    await account.save();

    return [
      {
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.display_phone_number,
      },
    ];
  }

  // ─── Send Message ──────────────────────────────────────────────────────

  /**
   * Send a WhatsApp message to a customer.
   *
   * @param {Object} conversation - Conversation document
   * @param {string} text - Message text
   * @param {Array} [attachments] - Attachment objects
   * @param {Object} [options] - Additional options (e.g., template name)
   * @returns {Promise<{platformMessageId: string, status: string}>}
   */
  async sendMessage(conversation, text, attachments = [], options = {}) {
    // Find the integration account for WhatsApp
    const IntegrationAccount = require("../../models/IntegrationAccount.model");
    const account = await IntegrationAccount.findOne({
      platform: "whatsapp",
      isActive: true,
      isConnected: true,
    }).sort({ createdAt: -1 });

    if (!account) {
      throw new Error("No active WhatsApp integration found. Please connect WhatsApp first.");
    }

    const phoneNumberId = account.metadata?.phoneNumberId || account.platformPageId;
    if (!phoneNumberId) {
      throw new Error("WhatsApp phone number ID not found. Please reconnect WhatsApp.");
    }

    // If there are attachments, send them as media messages
    if (attachments && attachments.length > 0) {
      return this._sendMediaMessage(account.accessToken, phoneNumberId, conversation, text, attachments);
    }

    // Send text message
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: conversation.platformUserId,
      type: "text",
      text: { preview_url: false, body: text },
    };

    const result = await this.client.post(
      account.accessToken,
      `/${phoneNumberId}/messages`,
      payload
    );

    const platformMessageId = result.messages?.[0]?.id || null;
    const status = result.messages?.[0]?.message_status || "sent";

    return {
      platformMessageId,
      status,
      raw: result,
    };
  }

  /**
   * Send a media message (image, video, audio, document).
   *
   * @private
   */
  async _sendMediaMessage(accessToken, phoneNumberId, conversation, text, attachments) {
    const attachment = attachments[0];
    const mediaType = this._mapMimeTypeToMediaType(attachment.mimeType);

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: conversation.platformUserId,
      type: mediaType,
      [mediaType]: {
        link: attachment.url,
        filename: attachment.filename || undefined,
        caption: text || undefined,
      },
    };

    const result = await this.client.post(
      accessToken,
      `/${phoneNumberId}/messages`,
      payload
    );

    const platformMessageId = result.messages?.[0]?.id || null;
    const status = result.messages?.[0]?.message_status || "sent";

    return {
      platformMessageId,
      status,
      raw: result,
    };
  }

  /**
   * Map a MIME type to a WhatsApp media type.
   * @private
   */
  _mapMimeTypeToMediaType(mimeType) {
    if (!mimeType) return "document";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "document";
  }

  // ─── Mark as Read ──────────────────────────────────────────────────────

  /**
   * Mark a WhatsApp message as read.
   *
   * @param {string} messageId - WhatsApp message ID
   * @param {Object} [options]
   * @param {string} [options.phoneNumberId] - Override phone number ID
   * @returns {Promise<boolean>}
   */
  async markAsRead(messageId, options = {}) {
    const IntegrationAccount = require("../../models/IntegrationAccount.model");
    const account = await IntegrationAccount.findOne({
      platform: "whatsapp",
      isActive: true,
      isConnected: true,
    }).sort({ createdAt: -1 });

    if (!account) {
      throw new Error("No active WhatsApp integration found");
    }

    const phoneNumberId = options.phoneNumberId || account.metadata?.phoneNumberId || account.platformPageId;

    const payload = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    };

    await this.client.post(account.accessToken, `/${phoneNumberId}/messages`, payload);
    return true;
  }

  // ─── Webhook ───────────────────────────────────────────────────────────

  /**
   * Receive and process an incoming WhatsApp webhook event.
   *
   * Handles:
   *   - Text messages
   *   - Image, video, audio, document, sticker
   *   - Contacts
   *   - Location
   *   - Interactive replies (button, list, quick reply)
   *   - Button replies
   *   - Order details
   *   - System messages (conversation started)
   *   - Status updates (sent, delivered, read, failed)
   *
   * @param {Object} payload - Raw webhook payload from Meta
   * @returns {Promise<{events: Array<{type: string, conversationId: string, messageId: string}>}>}
   */
  async receiveWebhook(payload) {
    const events = [];

    // Handle WhatsApp Business Account entry
    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "messages") continue;

        const value = change.value;
        if (!value) continue;

        // Handle status updates (sent, delivered, read, failed)
        if (value.statuses) {
          const statusEvents = await this._handleStatusUpdates(value);
          events.push(...statusEvents);
        }

        // Handle incoming messages
        if (value.messages) {
          const messageEvents = await this._handleIncomingMessages(value);
          events.push(...messageEvents);
        }
      }
    }

    return { events };
  }

  /**
   * Handle incoming WhatsApp messages.
   * @private
   */
  async _handleIncomingMessages(value) {
    const events = [];
    const metadata = value.metadata || {};
    const phoneNumberId = metadata.phone_number_id;
    const displayPhoneNumber = metadata.display_phone_number;

    for (const msg of value.messages || []) {
      const from = msg.from; // Customer's WhatsApp number
      const msgId = msg.id;
      const timestamp = msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now();

      try {
        // Parse the message based on type
        const parsed = this._parseMessage(msg);
        if (!parsed) continue; // Skip unsupported message types

        // Find or create customer using smart matching
        const customer = await this._findOrCreateCustomer(from, parsed);

        // Find or create conversation
        const conversation = await this._findOrCreateConversation(
          phoneNumberId,
          from,
          customer,
          displayPhoneNumber
        );

        // Append the message to the conversation
        conversation.messages.push({
          platformMessageId: msgId,
          senderType: "customer",
          senderId: customer?._id || null,
          senderName: customer?.firstName || customer?.name || from,
          text: parsed.text,
          messageType: parsed.messageType,
          attachments: parsed.attachments || [],
          deliveryStatus: "delivered",
          deliveredAt: new Date(timestamp),
        });

        // Update conversation metadata
        conversation.status = "open";
        conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        conversation.lastMessage = parsed.text || `[${parsed.messageType}]`;
        conversation.lastMessageAt = new Date(timestamp);
        await conversation.save();

        // Update lead if exists
        if (conversation.socialLeadId) {
          const SocialLead = require("../../models/SocialLead.model");
          await SocialLead.findByIdAndUpdate(conversation.socialLeadId, {
            conversationStatus: "open",
            unreadCount: conversation.unreadCount,
            lastMessage: parsed.text,
            lastMessageAt: new Date(timestamp),
          });
        }

        // Log the incoming message
        await logAction({
          action: "message_received",
          status: "success",
          platform: "whatsapp",
          entityType: "conversation",
          entityId: conversation._id,
          message: `WhatsApp message received from ${from}: ${(parsed.text || parsed.messageType).substring(0, 100)}`,
          metadata: {
            messageId: msgId,
            messageType: parsed.messageType,
            from,
          },
        });

        // Mark as read
        try {
          await this.markAsRead(msgId, { phoneNumberId });
        } catch (readErr) {
          // Non-critical — don't fail the whole event
          console.warn("[WHATSAPP] Failed to mark as read:", readErr.message);
        }

        events.push({
          type: "message",
          conversationId: conversation._id,
          messageId: msgId,
        });
      } catch (err) {
        console.error("[WHATSAPP] Error processing message:", err.message);
        events.push({
          type: "error",
          messageId: msgId,
          error: err.message,
        });
      }
    }

    return events;
  }

  /**
   * Parse a WhatsApp message into our standard format.
   * @private
   */
  _parseMessage(msg) {
    const msgType = msg.type;

    // Text messages
    if (msgType === "text") {
      return {
        text: msg.text?.body || "",
        messageType: "text",
        attachments: [],
      };
    }

    // Image messages
    if (msgType === "image") {
      return {
        text: msg.image?.caption || "",
        messageType: "image",
        attachments: [
          {
            url: msg.image?.link || msg.image?.id || "",
            filename: msg.image?.caption || "image",
            mimeType: "image/jpeg",
          },
        ],
      };
    }

    // Video messages
    if (msgType === "video") {
      return {
        text: msg.video?.caption || "",
        messageType: "video",
        attachments: [
          {
            url: msg.video?.link || msg.video?.id || "",
            filename: msg.video?.caption || "video",
            mimeType: "video/mp4",
          },
        ],
      };
    }

    // Audio messages
    if (msgType === "audio") {
      return {
        text: "",
        messageType: "audio",
        attachments: [
          {
            url: msg.audio?.link || msg.audio?.id || "",
            filename: "voice_message",
            mimeType: "audio/ogg",
          },
        ],
      };
    }

    // Document messages
    if (msgType === "document") {
      return {
        text: msg.document?.caption || "",
        messageType: "document",
        attachments: [
          {
            url: msg.document?.link || msg.document?.id || "",
            filename: msg.document?.filename || "document",
            mimeType: msg.document?.mime_type || "application/octet-stream",
          },
        ],
      };
    }

    // Contact messages
    if (msgType === "contacts") {
      const contacts = msg.contacts || [];
      const contact = contacts[0] || {};
      const name = [contact.name?.first_name, contact.name?.last_name]
        .filter(Boolean)
        .join(" ");
      const phones = contact.phones || [];
      const phone = phones[0]?.phone || "";

      return {
        text: `Contact: ${name}${phone ? ` - ${phone}` : ""}`,
        messageType: "contact",
        attachments: [],
        contactInfo: { name, phone, emails: contact.emails || [] },
      };
    }

    // Location messages
    if (msgType === "location") {
      return {
        text: `Location: ${msg.location?.latitude}, ${msg.location?.longitude}`,
        messageType: "location",
        attachments: [],
        location: {
          latitude: msg.location?.latitude,
          longitude: msg.location?.longitude,
          name: msg.location?.name,
          address: msg.location?.address,
        },
      };
    }

    // Interactive replies (button, list, quick reply)
    if (msgType === "interactive") {
      const interactive = msg.interactive || {};
      let replyText = "";

      if (interactive.type === "button_reply") {
        replyText = interactive.button_reply?.title || interactive.button_reply?.id || "";
      } else if (interactive.type === "list_reply") {
        replyText = interactive.list_reply?.title || interactive.list_reply?.id || "";
      }

      return {
        text: replyText,
        messageType: "quick_reply",
        attachments: [],
        interactive,
      };
    }

    // Button messages
    if (msgType === "button") {
      return {
        text: msg.button?.text || msg.button?.payload || "",
        messageType: "button",
        attachments: [],
      };
    }

    // Order messages
    if (msgType === "order") {
      return {
        text: `Order: ${msg.order?.catalog_id || ""}`,
        messageType: "text",
        attachments: [],
      };
    }

    // System messages (conversation started)
    if (msgType === "system") {
      return {
        text: msg.system?.body || "Conversation started",
        messageType: "system",
        attachments: [],
      };
    }

    // Unknown message type — log and skip
    console.warn(`[WHATSAPP] Unsupported message type: ${msgType}`, JSON.stringify(msg).substring(0, 200));
    return null;
  }

  /**
   * Handle status updates (sent, delivered, read, failed).
   * @private
   */
  async _handleStatusUpdates(value) {
    const events = [];

    for (const status of value.statuses || []) {
      const statusObj = status.status || {};
      const statusName = statusObj.status || status.status;
      const messageId = statusObj.id || status.id;
      const recipientId = status.recipient_id || statusObj.recipient_id;
      const timestamp = status.timestamp ? parseInt(status.timestamp, 10) * 1000 : Date.now();

      try {
        // Find the conversation by platform user ID
        const conversation = await Conversation.findOne({
          platform: "whatsapp",
          platformUserId: recipientId,
        });

        if (conversation) {
          // Update the last message's delivery status
          const lastMessage = conversation.messages[conversation.messages.length - 1];
          if (lastMessage && lastMessage.platformMessageId === messageId) {
            lastMessage.deliveryStatus = statusName;

            if (statusName === "delivered") {
              lastMessage.deliveredAt = new Date(timestamp);
            } else if (statusName === "read") {
              lastMessage.readAt = new Date(timestamp);
            }

            await conversation.save();
          }
        }

        events.push({
          type: "status",
          messageId,
          status: statusName,
          recipientId,
        });
      } catch (err) {
        console.error("[WHATSAPP] Error processing status update:", err.message);
      }
    }

    return events;
  }

  // ─── Customer & Conversation Management ────────────────────────────────

  /**
   * Find or create a customer using the WhatsApp phone number.
   * @private
   */
  async _findOrCreateCustomer(phoneNumber, parsedMessage) {
    // Try to find existing customer by phone
    const existingCustomer = await smartMatch.findByPhone(phoneNumber);

    if (existingCustomer) {
      // Update platform IDs
      if (!existingCustomer.platformIds) existingCustomer.platformIds = {};
      if (parsedMessage.contactInfo?.name) {
        existingCustomer.firstName = parsedMessage.contactInfo.name;
      }
      existingCustomer.platformIds.set("whatsapp", phoneNumber);
      await existingCustomer.save();
      return existingCustomer;
    }

    // Create a new customer
    const customerData = {
      mobileNo: phoneNumber,
      source: "whatsapp",
      platformIds: { whatsapp: phoneNumber },
    };

    if (parsedMessage.contactInfo?.name) {
      const nameParts = parsedMessage.contactInfo.name.split(" ");
      customerData.firstName = nameParts[0];
      customerData.lastName = nameParts.slice(1).join(" ") || "";
    }

    // Use the customer model's create method
    try {
      const customer = await Customer.create(customerData);
      return customer;
    } catch (err) {
      // If duplicate, try to find it again
      if (err.code === 11000) {
        return await smartMatch.findByPhone(phoneNumber);
      }
      throw err;
    }
  }

  /**
   * Find or create a conversation for a WhatsApp user.
   * @private
   */
  async _findOrCreateConversation(phoneNumberId, from, customer, displayPhoneNumber) {
    // Look for existing conversation for this WhatsApp user
    let conversation = await Conversation.findOne({
      platform: "whatsapp",
      platformUserId: from,
    });

    if (!conversation) {
      conversation = await Conversation.create({
        platform: "whatsapp",
        platformConversationId: `${phoneNumberId}_${from}`,
        platformUserId: from,
        platformPageId: phoneNumberId,
        customerId: customer?._id || null,
        customerName: customer?.firstName
          ? `${customer.firstName} ${customer.lastName || ""}`.trim()
          : displayPhoneNumber || from,
        status: "new",
        unreadCount: 0,
        messages: [],
      });

      // Create a SocialLead for tracking
      try {
        const SocialLead = require("../../models/SocialLead.model");
        const socialLead = await SocialLead.create({
          platform: "whatsapp",
          customerName: conversation.customerName,
          conversationId: conversation._id,
          conversationStatus: "new",
          unreadCount: 0,
          source: "whatsapp_webhook",
        });
        conversation.socialLeadId = socialLead._id;
        await conversation.save();
      } catch (leadErr) {
        // Non-critical — conversation still works
        console.warn("[WHATSAPP] Failed to create SocialLead:", leadErr.message);
      }
    }

    return conversation;
  }

  // ─── Profile ───────────────────────────────────────────────────────────

  /**
   * Fetch a WhatsApp user's profile.
   * WhatsApp Cloud API doesn't expose profile info directly,
   * but we can get basic info from the phone number.
   *
   * @param {string} platformUserId - WhatsApp phone number
   * @returns {Promise<Object>}
   */
  async fetchProfile(platformUserId) {
    // WhatsApp API doesn't provide profile info via Graph API
    // We can only return the phone number
    return {
      platformUserId,
      name: platformUserId,
      profilePicture: null,
    };
  }

  // ─── Fetch Messages ────────────────────────────────────────────────────

  /**
   * Fetch messages from WhatsApp.
   * WhatsApp Cloud API doesn't support fetching historical messages.
   * All messages must come through the webhook.
   *
   * @param {Object} conversation - Conversation document
   * @param {Date} [since] - Not supported by WhatsApp API
   * @returns {Promise<Array>} Empty array (messages are stored in DB)
   */
  async fetchMessages(conversation, since = null) {
    // WhatsApp does not support fetching historical messages via API
    // All messages are received via webhook and stored in the database
    return [];
  }

  // ─── Process Webhook (legacy) ──────────────────────────────────────────

  /**
   * Legacy processWebhook — delegates to receiveWebhook.
   *
   * @param {Object} payload - Webhook payload
   * @returns {Promise<Object>}
   */
  async processWebhook(payload) {
    return this.receiveWebhook(payload);
  }
}

// ─── Self-register with Platform Manager ──────────────────────────────────

const platformManager = require("../platformManager.service");
const adapter = new WhatsAppAdapter();
platformManager.registerAdapter("whatsapp", adapter);

module.exports = WhatsAppAdapter;