/**
 * eBay Platform Adapter
 *
 * Implements the BaseAdapter interface for eBay Marketplace integration.
 *
 * Handles:
 *   - OAuth connection (authorization URL, token exchange, refresh)
 *   - Order fetching (Fulfillment API)
 *   - Listing fetching (Inventory API)
 *   - Message fetching (Messaging API)
 *   - Health checks
 *   - Disconnect/revoke
 *
 * Self-registers with PlatformManager on require().
 */
const crypto = require("crypto");
const BaseAdapter = require("./baseAdapter");
const { EbayApiClient, EbayAuthError } = require("../clients/ebayApiClient");
const { classifyEbayError, missingRefreshTokenError } = require("../integrationErrors");
const platformManager = require("../platformManager.service");
const IntegrationAccount = require("../../models/IntegrationAccount.model");
const MarketplaceLead = require("../../models/MarketplaceLead.model");
const Conversation = require("../../models/Conversation.model");
const { logAction } = require("../auditLog.service");

// ─── eBay OAuth Diagnostic Tracing (observability only, no behavior change) ─
// Generates/logs a traceId that follows one OAuth attempt across every step:
// connect() -> callback -> exchangeAuthorizationCode() -> Mongo save ->
// fetchBusinessAccount() -> registerWebhook() -> platformStatus() -> redirect.

function generateEbayTraceId() {
  return crypto.randomBytes(4).toString("hex");
}

function ebayTrace(traceId, step, data = {}) {
  console.log(JSON.stringify({
    tag: "[EBAY][TRACE]",
    traceId: traceId || "no-trace-id",
    timestamp: new Date().toISOString(),
    platform: "ebay",
    step,
    ...data,
  }));
}

function ebayTraceError(traceId, step, functionName, err) {
  const stackLines = err && err.stack ? err.stack.split("\n") : [];
  const location = stackLines[1] ? stackLines[1].trim() : null;

  console.error(JSON.stringify({
    tag: "[EBAY][ERROR]",
    traceId: traceId || "no-trace-id",
    timestamp: new Date().toISOString(),
    platform: "ebay",
    step,
    function: functionName,
    file: __filename,
    location,
    message: err?.message,
    code: err?.code,
    cause: err?.cause ? String(err.cause) : null,
    isAxiosError: Boolean(err?.isAxiosError),
    axiosRequest: err?.config
      ? { method: err.config.method, url: err.config.url, baseURL: err.config.baseURL, timeoutMs: err.config.timeout }
      : null,
    axiosResponseStatus: err?.response?.status ?? null,
    axiosResponseBody: err?.response?.data ?? null,
    stack: err?.stack,
  }));
}

class EbayAdapter extends BaseAdapter {
  constructor() {
    super("ebay");

    this.clientId = process.env.EBAY_CLIENT_ID;
    this.clientSecret = process.env.EBAY_CLIENT_SECRET;
    this.devId = process.env.EBAY_DEV_ID;
    this.ruName = process.env.EBAY_RUNAME;
    this.scope = process.env.EBAY_SCOPES || "https://api.ebay.com/oauth/api_scope";
    this.redirectUri = process.env.EBAY_REDIRECT_URI || "http://api.autohubexpress.us/integrations/ebay/callback";

    this.client = new EbayApiClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  // ─── OAuth ──────────────────────────────────────────────────────────────

  /**
   * Generate the eBay OAuth authorization URL.
   *
   * @param {Object} [options]
   * @param {string} [options.redirectUri] - Override redirect URI
   * @param {string} [options.state] - OAuth state parameter
   * @returns {Promise<string>} OAuth authorization URL
   */
  async connect(options = {}) {
    const traceId = options.traceId || null;
    const ruName = options.ruName || this.ruName;

    // Check required credentials
    if (!this.clientId) {
      const err = new Error("EBAY_CLIENT_ID is missing from the server environment. Configure your eBay Developer App credentials in the backend .env file.");
      err.code = "EBAY_NOT_CONFIGURED";
      err.statusCode = 500;
      ebayTraceError(traceId, "CONNECT_MISSING_CLIENT_ID", "EbayAdapter.connect", err);
      throw err;
    }

    if (!ruName) {
      const err = new Error("EBAY_RUNAME (eBay Redirect URL Name) is missing. Create one in the eBay Developer Portal under User Tokens → RuName and add it to the backend .env file.");
      err.code = "EBAY_RUNAME_MISSING";
      err.statusCode = 500;
      ebayTraceError(traceId, "CONNECT_MISSING_RUNAME", "EbayAdapter.connect", err);
      throw err;
    }

    const scope = options.scope || this.scope;
    const state = options.state || "";

    // ─── DIAGNOSTIC: LOG 2 — before OAuth URL generation ────────────────────
    ebayTrace(traceId, "BEFORE_AUTH_URL_GENERATION", {
      function: "EbayAdapter.connect",
      clientId: this.clientId,
      ruName,
      scope,
      state,
    });

    console.log("========== EBAY CONNECT ==========");
    console.log("RuName:", ruName);
    console.log("Scope:", scope);
    console.log("State:", state);

    const authUrl = this.client.getAuthorizationUrl(ruName, scope, state);

    console.log("OAuth URL:", authUrl);
    console.log("==================================");

    // ─── DIAGNOSTIC: LOG 3 — generated OAuth URL ────────────────────────────
    ebayTrace(traceId, "AUTH_URL_GENERATED", {
      function: "EbayAdapter.connect",
      authUrl,
    });

    return authUrl;

    return this.client.getAuthorizationUrl(ruName, scope, state);
  }

  /**
   * Exchange an authorization code for tokens.
   *
   * @param {string} code - Authorization code from OAuth callback
   * @param {Object} [options]
   * @param {string} [options.ruName] - Override RuName
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
   */
  async exchangeAuthorizationCode(code, options = {}) {
    const traceId = options.traceId || null;
    const ruName = options.ruName || this.ruName || options.redirectUri;

    // ─── DIAGNOSTIC: LOG 5 — before token exchange (adapter layer) ──────────
    ebayTrace(traceId, "BEFORE_TOKEN_EXCHANGE", {
      function: "EbayAdapter.exchangeAuthorizationCode",
      codeLength: code ? code.length : 0,
      hasClientId: Boolean(this.clientId),
      hasClientSecret: Boolean(this.clientSecret),
      ruName,
    });

    if (!this.clientId || !this.clientSecret) {
      const err = new Error("EBAY_CLIENT_ID or EBAY_CLIENT_SECRET is missing from the server environment.");
      err.code = "EBAY_NOT_CONFIGURED";
      err.statusCode = 500;
      ebayTraceError(traceId, "TOKEN_EXCHANGE_MISSING_CREDENTIALS", "EbayAdapter.exchangeAuthorizationCode", err);
      throw err;
    }

    if (!ruName) {
      const err = new Error("EBAY_RUNAME is required for token exchange.");
      err.code = "EBAY_RUNAME_MISSING";
      err.statusCode = 500;
      ebayTraceError(traceId, "TOKEN_EXCHANGE_MISSING_RUNAME", "EbayAdapter.exchangeAuthorizationCode", err);
      throw err;
    }

    let result;
    try {
      result = await this.client.exchangeAuthorizationCode(code, ruName, traceId);
    } catch (err) {
      ebayTraceError(traceId, "TOKEN_EXCHANGE_FAILED", "EbayAdapter.exchangeAuthorizationCode", err);
      throw err;
    }

    // ─── DIAGNOSTIC: LOG 6 — after token exchange (adapter layer) ───────────
    ebayTrace(traceId, "AFTER_TOKEN_EXCHANGE", {
      function: "EbayAdapter.exchangeAuthorizationCode",
      accessTokenReceived: Boolean(result.accessToken),
      refreshTokenReceived: Boolean(result.refreshToken),
      expiresIn: result.expiresIn,
      tokenType: result.tokenType,
    });

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: result.tokenType,
    };
  }

  // ─── Token Management ──────────────────────────────────────────────────

  /**
   * Refresh an expired access token.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<Object>} Updated account
   */
  async refreshToken(account) {
    if (!account.refreshToken) {
      throw missingRefreshTokenError();
    }

    let result;
    try {
      result = await this.client.refreshAccessToken(account.refreshToken, this.scope);
    } catch (err) {
      throw classifyEbayError(err);
    }

    account.accessToken = result.accessToken;
    if (result.refreshToken) {
      account.refreshToken = result.refreshToken;
    }
    account.tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000);
    account.lastSyncAt = new Date();
    await account.save();

    await logAction({
      action: "token_refreshed",
      status: "success",
      platform: "ebay",
      entityType: "integration_account",
      entityId: account._id,
      message: "eBay access token refreshed successfully",
    });

    return account;
  }

  // ─── Webhook (Not used by eBay in Phase 1) ─────────────────────────────

  /**
   * eBay does not use webhook verification in the standard sense.
   * Marketplace Account Delegation handles push notifications.
   *
   * @returns {{ verified: boolean, challenge: null }}
   */
  verifyWebhook() {
    return { verified: false, challenge: null };
  }

  /**
   * Placeholder for future webhook processing.
   *
   * @param {Object} payload - Webhook payload
   * @returns {Promise<Object>}
   */
  async processWebhook(payload) {
    console.log(`[EBAY] Webhook received (not yet implemented):`, JSON.stringify(payload).substring(0, 200));
    return { processed: false, message: "Webhook processing not yet implemented for eBay" };
  }

  /**
   * Placeholder for webhook registration.
   *
   * @returns {Promise<boolean>}
   */
  async registerWebhook(account, traceId = null) {
    // ─── DIAGNOSTIC: LOG 11 — before registerWebhook ────────────────────────
    ebayTrace(traceId, "BEFORE_REGISTER_WEBHOOK", { function: "EbayAdapter.registerWebhook" });

    console.log("[EBAY] Webhook registration not implemented — eBay uses Marketplace Account Delegation");

    // ─── DIAGNOSTIC: LOG 12 — after registerWebhook ─────────────────────────
    ebayTrace(traceId, "AFTER_REGISTER_WEBHOOK", { function: "EbayAdapter.registerWebhook", result: false });

    return false;
  }

  /**
   * Placeholder for receiving webhook events.
   *
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async receiveWebhook(payload) {
    return this.processWebhook(payload);
  }

  // ─── Health Check ──────────────────────────────────────────────────────

  /**
   * Verify the eBay connection using locally-stored token state.
   *
   * eBay's REST API has no scope-independent token-introspection endpoint,
   * so health is derived from the access token's presence and expiry
   * (tokenExpiresAt is set directly from eBay's own `expires_in` at
   * token-exchange time) instead of an extra network call.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{healthy: boolean, details: Object}>}
   */
  async healthCheck(account, traceId = null) {
    const hasToken = !!account.accessToken;
    const expired = !!account.isTokenExpired;
    const healthy = hasToken && !expired;

    // ─── DIAGNOSTIC: HEALTH DEBUGGING ────────────────────────────────────────
    ebayTrace(traceId, "HEALTH_CHECK", {
      function: "EbayAdapter.healthCheck",
      tokenExists: hasToken,
      refreshTokenExists: !!account.refreshToken,
      tokenExpiresAt: account.tokenExpiresAt,
      currentTime: new Date().toISOString(),
      healthyResult: healthy,
    });

    if (healthy) {
      return {
        healthy: true,
        details: {
          healthy: true,
          environment: this.client.environment,
          tokenExpiresAt: account.tokenExpiresAt,
        },
      };
    }

    return {
      healthy: false,
      details: {
        healthy: false,
        error: !hasToken ? "No eBay access token stored" : "eBay access token has expired",
        isAuthError: true,
        environment: this.client.environment,
      },
    };
  }

  // ─── Disconnect ────────────────────────────────────────────────────────

  /**
   * Disconnect and revoke token access.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<boolean>}
   */
  async disconnect(account) {
    try {
      await this.client.revokeToken(account.accessToken, "access_token");
      if (account.refreshToken) {
        await this.client.revokeToken(account.refreshToken, "refresh_token");
      }
    } catch (err) {
      console.warn("[EBAY] Token revocation warning:", err.message);
    }

    account.isActive = false;
    account.isConnected = false;
    account.accessToken = null;
    account.refreshToken = null;
    account.tokenExpiresAt = null;
    // accessToken is a required field on the shared IntegrationAccount schema
    // (needed while connected, for every platform). Disconnect intentionally
    // nulls it out, so full document validation must be skipped for this one
    // save — otherwise Mongoose rejects it with "Access token is required."
    await account.save({ validateBeforeSave: false });

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: "ebay",
      entityType: "integration_account",
      entityId: account._id,
      message: "eBay disconnected successfully",
    });

    return true;
  }

  // ─── Profile / Business Account (minimal) ──────────────────────────────

  /**
   * Fetch basic eBay user info from the token.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{businessAccountId: string, businessName: string}>}
   */
  async fetchBusinessAccount(account, traceId = null) {
    // ─── DIAGNOSTIC: LOG 9 — before fetchBusinessAccount ────────────────────
    ebayTrace(traceId, "BEFORE_FETCH_BUSINESS_ACCOUNT", {
      function: "EbayAdapter.fetchBusinessAccount",
      accountId: account?._id,
    });

    try {
      const tokenInfo = await this.client.get(account.accessToken, "/oauth2/token/info");
      account.platformUserId = tokenInfo.uid || account.platformUserId;
      account.platformName = tokenInfo.uid || "eBay User";
      account.metadata = {
        ...account.metadata,
        environment: this.client.environment,
      };
      await account.save();

      // ─── DIAGNOSTIC: LOG 10 — after fetchBusinessAccount (success) ───────
      ebayTrace(traceId, "AFTER_FETCH_BUSINESS_ACCOUNT", {
        function: "EbayAdapter.fetchBusinessAccount",
        success: true,
        uid: tokenInfo.uid,
      });

      return {
        businessAccountId: tokenInfo.uid || account._id.toString(),
        businessName: tokenInfo.uid || "eBay User",
      };
    } catch (err) {
      console.warn("[EBAY] fetchBusinessAccount warning:", err.message);

      // ─── DIAGNOSTIC: LOG 10 — after fetchBusinessAccount (failure) ───────
      ebayTraceError(traceId, "FETCH_BUSINESS_ACCOUNT_FAILED", "EbayAdapter.fetchBusinessAccount", err);

      return {
        businessAccountId: account._id.toString(),
        businessName: "eBay User",
      };
    }
  }

  /**
   * Not applicable for eBay.
   */
  async fetchPhoneNumber() {
    return [];
  }

  // ─── Send Message (not yet supported) ──────────────────────────────────

  /**
   * Send a message via eBay Messaging API.
   * Not yet implemented — eBay messaging requires specific order context.
   *
   * @returns {Promise<{platformMessageId: string, status: string}>}
   */
  async sendMessage() {
    throw new Error("sendMessage() not yet implemented for eBay — requires order context");
  }

  /**
   * Mark a message as read on eBay.
   * Not yet implemented.
   *
   * @returns {Promise<boolean>}
   */
  async markAsRead() {
    throw new Error("markAsRead() not yet implemented for eBay");
  }

  /**
   * Fetch profile for a platform user ID.
   *
   * @param {string} platformUserId
   * @returns {Promise<Object>}
   */
  async fetchProfile(platformUserId) {
    return { platformUserId, name: platformUserId, platform: "ebay" };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MARKETPLACE SYNC METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch orders from eBay Fulfillment API.
   *
   * @param {Object} account - IntegrationAccount document
   * @param {Object} [options]
   * @param {string} [options.filter] - eBay filter string
   * @param {number} [options.limit] - Results per page (max 200)
   * @returns {Promise<Array<Object>>} Array of created/updated MarketplaceLead documents
   */
  async fetchOrders(account, options = {}) {
    const limit = options.limit || 50;
    const filter = options.filter || "orderfulfillmentstatus:{NOT_STARTED}";

    const leads = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.get(account.accessToken, "/sell/fulfillment/v1/order", {
        limit,
        offset,
        filter,
      });

      const orders = result.orders || [];

      for (const order of orders) {
        const lead = await this._upsertOrder(order);
        leads.push(lead);
      }

      offset += limit;
      hasMore = result.total && offset < result.total;
    }

    await logAction({
      action: "orders_synced",
      status: "success",
      platform: "ebay",
      message: `Synced ${leads.length} eBay orders`,
      metadata: { count: leads.length },
    });

    return leads;
  }

  /**
   * Fetch active listings from eBay Inventory API.
   *
   * @param {Object} account - IntegrationAccount document
   * @param {Object} [options]
   * @param {number} [options.limit] - Results per page
   * @returns {Promise<Array<Object>>} Array of created/updated MarketplaceLead documents
   */
  async fetchListings(account, options = {}) {
    const limit = options.limit || 50;

    const leads = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.get(account.accessToken, "/sell/inventory/v1/inventory_item", {
        limit,
        offset,
      });

      const items = result.inventoryItems || [];

      for (const item of items) {
        const lead = await this._upsertListing(item);
        leads.push(lead);
      }

      offset += limit;
      hasMore = result.total && offset < result.total;
    }

    await logAction({
      action: "listings_synced",
      status: "success",
      platform: "ebay",
      message: `Synced ${leads.length} eBay listings`,
      metadata: { count: leads.length },
    });

    return leads;
  }

  /**
   * Fetch messages from eBay Messaging API.
   *
   * @param {Object} account - IntegrationAccount document
   * @param {Object} [options]
   * @param {number} [options.limit] - Results per page
   * @returns {Promise<Array<Object>>} Array of created/updated Conversation documents
   */
  async fetchMessages(account, options = {}) {
    const limit = options.limit || 50;

    const conversations = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.get(account.accessToken, "/sell/messaging/v1/message", {
        limit,
        offset,
      });

      const messages = result.messages || [];

      for (const msg of messages) {
        const conversation = await this._upsertMessage(msg);
        conversations.push(conversation);
      }

      offset += limit;
      hasMore = result.total && offset < result.total;
    }

    await logAction({
      action: "messages_synced",
      status: "success",
      platform: "ebay",
      message: `Synced ${conversations.length} eBay conversations`,
      metadata: { count: conversations.length },
    });

    return conversations;
  }

  /**
   * Full sync: orders, listings, then messages.
   *
   * @param {Object} account - IntegrationAccount document
   * @param {Object} [options]
   * @returns {Promise<{orders: Array, listings: Array, messages: Array}>}
   */
  async sync(account, options = {}) {
    // Ensure token is still valid before syncing
    if (account.isTokenExpired && account.refreshToken) {
      await this.refreshToken(account);
    }

    const [orders, listings, messages] = await Promise.all([
      this.fetchOrders(account, options),
      this.fetchListings(account, options),
      this.fetchMessages(account, options),
    ]);

    account.lastSyncAt = new Date();
    account.errorCount = 0;
    account.lastErrorMessage = null;
    await account.save();

    return { orders, listings, messages };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  /**
   * Upsert a MarketplaceLead from an eBay order object.
   *
   * @param {Object} order - eBay order object from Fulfillment API
   * @returns {Promise<Object>} MarketplaceLead document
   */
  async _upsertOrder(order) {
    const orderId = order.orderId;
    const buyer = order.buyer || {};
    const shippingAddress = buyer.shippingAddress?.addressLine1
      ? {
          street: buyer.shippingAddress.addressLine1,
          city: buyer.shippingAddress.city,
          state: buyer.shippingAddress.stateOrProvince,
          zip: buyer.shippingAddress.postalCode,
          country: buyer.shippingAddress.country,
        }
      : {};
    const lineItem = (order.lineItems || [])[0] || {};

    const price = order.pricingSummary?.price?.value
      ? parseFloat(order.pricingSummary.price.value)
      : 0;
    const currency = order.pricingSummary?.price?.currency || "USD";

    const leadData = {
      marketplace: "ebay",
      marketplaceOrderId: orderId,
      marketplaceCustomerId: buyer.username,
      customerName: buyer.username,
      customerEmail: buyer.email,
      customerPhone: buyer.contactPhoneNumber,
      shippingAddress,
      productName: lineItem.title,
      productSku: lineItem.sku,
      quantity: lineItem.quantity || 1,
      price,
      currency,
      orderStatus: this._mapOrderStatus(order.orderPaymentStatus),
      shippingStatus: this._mapShippingStatus(order.fulfillmentStatus),
      trackingNumber: lineItem.trackingNumber,
      carrier: lineItem.shippingCarrier,
      estimatedDelivery: lineItem.estimatedDeliveryDate ? new Date(lineItem.estimatedDeliveryDate) : null,
      source: "eBay Sync",
    };

    // Upsert by marketplaceOrderId to avoid duplicates
    let lead = await MarketplaceLead.findOne({
      marketplace: "ebay",
      marketplaceOrderId: orderId,
    });

    if (lead) {
      Object.assign(lead, leadData);
    } else {
      lead = new MarketplaceLead(leadData);
    }

    await lead.save();
    return lead;
  }

  /**
   * Upsert a MarketplaceLead from an eBay inventory item (listing).
   *
   * @param {Object} item - eBay inventory item from Inventory API
   * @returns {Promise<Object>} MarketplaceLead document
   */
  async _upsertListing(item) {
    const sku = item.sku;
    const product = item.product || {};
    const title = product.title || sku;
    const availability = item.availability?.shipToLocationAvailability || {};
    const priceInfo = product.prices?.[0] || {};

    const listingData = {
      marketplace: "ebay",
      marketplaceListingId: sku,
      marketplaceOrderId: null, // This is a listing, not an order
      productName: title,
      productSku: sku,
      quantity: availability.quantity || 0,
      price: priceInfo.value ? parseFloat(priceInfo.value) : 0,
      currency: priceInfo.currency || "USD",
      orderStatus: "pending", // Listings use "pending" as default — repurposed as listing status
      source: "eBay Listing Sync",
    };

    // Upsert by marketplaceListingId
    let lead = await MarketplaceLead.findOne({
      marketplace: "ebay",
      marketplaceListingId: sku,
      marketplaceOrderId: null,
    });

    if (lead) {
      Object.assign(lead, listingData);
    } else {
      lead = new MarketplaceLead(listingData);
    }

    await lead.save();
    return lead;
  }

  /**
   * Upsert a Conversation from an eBay message.
   *
   * @param {Object} msg - eBay message object from Messaging API
   * @returns {Promise<Object>} Conversation document
   */
  async _upsertMessage(msg) {
    const messageId = msg.messageId;
    const sender = msg.sender || "eBay User";
    const receiver = msg.recipient || "Unknown";
    const text = msg.message || msg.body || "";
    const timestamp = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const platformConversationId = msg.conversationId || msg.orderId || messageId;

    // Find or create conversation
    let conversation = await Conversation.findOne({
      platform: "ebay",
      platformConversationId,
    });

    if (!conversation) {
      conversation = await Conversation.create({
        platform: "ebay",
        platformConversationId,
        platformUserId: sender,
        customerName: sender,
        status: "new",
        messages: [],
      });
    }

    // Add message if not a duplicate
    const isDuplicate = conversation.messages.some(
      (m) => m.platformMessageId === messageId
    );

    if (!isDuplicate) {
      conversation.messages.push({
        platformMessageId: messageId,
        senderType: "customer",
        senderName: sender,
        text,
        messageType: "text",
        createdAt: timestamp,
      });

      conversation.status = "open";
      await conversation.save();
    }

    return conversation;
  }

  /**
   * Map eBay payment status to MarketplaceLead orderStatus.
   *
   * @param {string} status - eBay orderPaymentStatus
   * @returns {string}
   */
  _mapOrderStatus(status) {
    const map = {
      PAID: "confirmed",
      PENDING: "awaiting_payment",
      FAILED: "cancelled",
      REFUNDED: "refunded",
      PARTIALLY_REFUNDED: "refunded",
      ESCROW_CHECK: "pending",
      CANCELLED: "cancelled",
    };
    return map[status] || "pending";
  }

  /**
   * Map eBay fulfillment status to MarketplaceLead shippingStatus.
   *
   * @param {string} status - eBay fulfillmentStatus
   * @returns {string}
   */
  _mapShippingStatus(status) {
    const map = {
      NOT_STARTED: "not_shipped",
      IN_PROGRESS: "partially_shipped",
      SHIPPED: "shipped",
      DELIVERED: "delivered",
      CANCELLED: "returned",
    };
    return map[status] || "not_shipped";
  }
}

// ─── Self-Registration ──────────────────────────────────────────────────────
// Registers the eBay adapter with PlatformManager on require().
// This follows the same pattern as the WhatsApp adapter.

const instance = new EbayAdapter();
platformManager.registerAdapter("ebay", instance);
console.log("[EBAY] eBay adapter registered with PlatformManager");

module.exports = instance;