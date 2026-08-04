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
const { convert } = require("html-to-text");
const BaseAdapter = require("./baseAdapter");
const { EbayApiClient, EbayAuthError } = require("../clients/ebayApiClient");
const EbayTradingClient = require("../clients/ebayTradingClient");
const { classifyEbayError, missingRefreshTokenError } = require("../integrationErrors");
const platformManager = require("../platformManager.service");
const IntegrationAccount = require("../../models/IntegrationAccount.model");
const MarketplaceListing = require("../../models/MarketplaceListing.model");
const Conversation = require("../../models/Conversation.model");
const Order = require("../../models/Order.model");
const smartMatchService = require("../smartMatch.service");
const { normalizeOrderStatuses } = require("../orderStatusMapper");
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

    this.tradingClient = new EbayTradingClient();
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
    console.log("Raw EBAY_SCOPES:", process.env.EBAY_SCOPES);
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
      scope: result.scope,
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

  // ─── Send Message ────────────────────────────────────────────────────────

  /**
   * Send a reply via eBay's Message API, within the existing conversation.
   *
   * Prerequisites are verified before attempting anything — nothing is ever
   * faked or assumed:
   *   - `conversation.platformConversationId` must be present (it is what
   *     eBay's own sendMessage call uses to target the existing thread —
   *     this app already captures/stores it for every synced conversation).
   *   - Attachments are not sent: eBay's attachment format for this API was
   *     never confirmed against real documentation, so this fails clearly
   *     rather than guessing a schema.
   *   - Success is only ever reported if eBay's API call itself succeeds —
   *     the underlying client throws on any non-success response, so there
   *     is no path to a false "sent" result.
   *
   * IMPORTANT: eBay's Message API (commerce/message/v1) is a Limited
   * Release API per eBay's own documentation — it requires this eBay
   * developer account to have been specifically approved by eBay for
   * production access. If that access hasn't been granted, this call (and
   * the pre-existing getConversations/getConversation reads) will fail with
   * an access-denied-style error from eBay, surfaced via the thrown error
   * below — that is an eBay-side approval gate, not something fixable here.
   *
   * @param {Object} conversation - Conversation document
   * @param {string} text - reply body
   * @param {Array} [attachments]
   * @returns {Promise<{platformMessageId: string|null, status: string}>}
   */
  async sendMessage(conversation, text, attachments = []) {
    if (!conversation?.platformConversationId) {
      throw new Error(
        "Cannot send eBay reply: this conversation is missing its eBay conversation ID."
      );
    }

    if (attachments && attachments.length > 0) {
      throw new Error(
        "Sending attachments via eBay replies is not yet supported — please resend without attachments."
      );
    }

    const account = await IntegrationAccount.findOne({
      platform: "ebay",
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!account) {
      throw new Error("No active eBay integration found. Please connect eBay first.");
    }

    if (account.isTokenExpired && account.refreshToken) {
      await this.refreshToken(account);
    }

    const response = await this.client.sendMessage(account.accessToken, {
      conversationId: conversation.platformConversationId,
      messageText: text,
    });

    // The client throws on any non-success response, so reaching this line
    // means eBay actually accepted the message — never assumed.
    return {
      platformMessageId: response?.messageId || null,
      status: "sent",
    };
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
   * @returns {Promise<Array<Object>>} Array of created/updated MarketplaceListing documents
   */
  async fetchOrders(account, options = {}) {
    const limit = options.limit || 50;
    const filter = options.filter;
    // || "orderfulfillmentstatus:{NOT_STARTED}";

    const leads = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const params = {
        limit,
        offset,
      };

      if (filter) {
        params.filter = filter;
      }

      const result = await this.client.get(
        account.accessToken,
        "/sell/fulfillment/v1/order",
        params
      );

      
      // const result = await this.client.get(account.accessToken, "/sell/fulfillment/v1/order", {
      //   limit,
      //   offset,
      //   filter,
      // });

      const orders = result.orders || [];

      for (const order of orders) {
        const lead = await this._upsertOrder(order, account);
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
   * @returns {Promise<Array<Object>>} Array of created/updated MarketplaceListing documents
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

      const inventoryItems = result.inventoryItems || [];
      
      // Trading API fetch
      let tradingItems = [];
      
      try {
        const tradingResult =
          await this.tradingClient.getManualListings(account.accessToken);

        const activeList = 
          tradingResult?.GetMyeBaySellingResponse?.ActiveList;

        const items = activeList?.ItemArray?.Item || [];

        tradingItems = Array.isArray(items)
          ? items
          : items
              ? [items]
              : [];
      } catch (error) {
        console.warn(
          "[EBAY] Trading API listings unavailable:",
          error.message
        );
      }

      const normalizedTradingItems = tradingItems.map(item =>
        this._normalizeTradingListing(item)
      );

      const allItems = [
        ...inventoryItems,
        ...normalizedTradingItems,
      ];

      const seen = new Set();

      for (const item of allItems) {
        if (seen.has(item.sku)) continue;

        seen.add(item.sku);

        const lead = await this._upsertListing(item, account);
        leads.push(lead);
      }

      // for (const item of inventoryItems) {
      //   const lead = await this._upsertListing(item);
      //   leads.push(lead);
      // }

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
      const result = await this.client.getConversations(
        account.accessToken,
        {
          limit,
          offset,
        }
      );

      const conversationList = result.conversations || [];

      for (const conversationSummary of conversationList) {
        const conversationDetails = await this.client.getConversation(
          account.accessToken,
          conversationSummary.conversationId,
          conversationSummary.conversationType
        );
        console.log("========= CONVERSATION SUMMARY =========");
        console.log(JSON.stringify(conversationSummary, null, 2));
        console.log("\n========== EBAY CONVERSATION DETAILS ==============");
        console.log(JSON.stringify(conversationDetails, null, 2));
        console.log("============================\n");

        const messages = conversationDetails.messages || [];

        if (messages.length > 0) {
          console.log("\n========== FIRST EBAY MESSAGE ==========");
          console.log(JSON.stringify(messages[0], null, 2));
          console.log("===========================================\n");
        }

        for (const msg of messages) {
          const conversation = await this._upsertMessage(msg, conversationSummary, account);
          conversations.push(conversation);
        }
      }

      // const messages = result.conversations || [];
      // const result = await this.client.get(account.accessToken, "/sell/messaging/v1/message", {
      //   limit,
      //   offset,
      // });

      // const messages = result.messages || [];

      // for (const msg of messages) {
      //   const conversation = await this._upsertMessage(msg);
      //   conversations.push(conversation);
      // }

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

  async testConversations(account) {
    if (account.isTokenExpired && account.refreshToken) {
      await this.refreshToken(account);
    }

    return await this.client.getConversations(account.accessToken, {
      limit: 10,
      offset: 0,
    });
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
   * Upsert a MarketplaceListing from an eBay order object.
   *
   * @param {Object} order - eBay order object from Fulfillment API
   * @param {Object} [account] - IntegrationAccount document (used to fetch
   *   real tracking/carrier data via a best-effort shipping_fulfillment call)
   * @returns {Promise<Object>} MarketplaceListing document
   */
  async _upsertOrder(order, account) {
    const buyer = order.buyer || {};
    const lineItems = order.lineItems || [];

    // eBay's `buyer` object does not carry direct contact info (confirmed
    // against eBay's Fulfillment API docs — it only has the buyer's
    // username/registration address). Real contact details are on the
    // shipping instructions instead: shipTo.email (only returned within 14
    // days of order creation) and shipTo.primaryPhone.phoneNumber (only
    // within 90 days) — both eBay-side privacy windows, not bugs. shipTo's
    // fullName is also a real name, unlike the pseudonymous buyer username.
    const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
    const shipToEmail = shipTo.email || null;
    const shipToPhone = shipTo.primaryPhone?.phoneNumber || null;
    const shipToName = shipTo.fullName || null;

    // Order Status must never be manually maintained in the CRM — it is
    // always derived from the marketplace's own data here, at sync time.
    const { orderStatus, paymentStatus, refundStatus, shippingStatus } = normalizeOrderStatuses(order);

    const orderData = {
      platform: "ebay",

      orderId: order.orderId,
      legacyOrderId: order.legacyOrderId || null,

      buyerUsername: buyer.username || null,
      buyerEmail: shipToEmail || buyer.email || null,

      // `status` is kept as the canonical Order Status value (same field,
      // now trustworthy instead of a raw/unnormalized passthrough — no
      // schema change, no change to what reads this field).
      status: orderStatus,
      paymentStatus,
      refundStatus,
      shippingStatus,
      customerName: shipToName || buyer.username || null,
      customerPhone: shipToPhone || null,

      createdAtEbay: order.creationDate
        ? new Date(order.creationDate)
        : null,

      total: parseFloat(
        order.pricingSummary?.total?.value ||
        order.pricingSummary?.price?.value ||
        0
      ),

      currency:
        order.pricingSummary?.total?.currency ||
        order.pricingSummary?.price?.currency ||
        "USD",

      items: lineItems.map((item) => ({
        itemId: item.lineItemId,
        title: item.title,
        sku: item.sku,
        quantity: item.quantity,
        price: parseFloat(item.lineItemCost?.value || 0),
      })),

      shippingAddress: {
        name:
          buyer.shippingAddress?.fullName || "",
        city:
          buyer.shippingAddress?.city || "",
        state:
          buyer.shippingAddress?.stateOrProvince || "",
        postalCode:
          buyer.shippingAddress?.postalCode || "",
        country:
          buyer.shippingAddress?.country || "",
      },

      rawData: order,
    };

    // CRM linking is best-effort: a failure here must never block the order
    // itself from being synced/upserted. Failures are logged both to the
    // console AND the AuditLog collection (via logAction) — console.error
    // alone is not captured to any file this system persists (logs/*.log are
    // HTTP-access logs only), so without the audit-log entry a silent
    // customer-linking failure would be effectively invisible.
    try {
      const { customer } = await smartMatchService.findOrCreateCustomer({
        platform: "ebay",
        email: shipToEmail,
        phone: shipToPhone,
        name: shipToName || buyer.username || null,
      });
      orderData.customerId = customer?._id || null;
    } catch (error) {
      console.error("[EBAY] Order customer-match failed (non-fatal):", error.message || error);
      await logAction({
        action: "system_error",
        status: "failure",
        platform: "ebay",
        entityType: "order",
        message: `Order ${order.orderId}: customer-match failed`,
        errorMessage: error.message || String(error),
      });
    }

    try {
      if (buyer.username) {
        // Read-only lookup — never creates/modifies a Conversation from here.
        const existingConversation = await Conversation.findOne({
          platform: "ebay",
          platformUserId: buyer.username,
        }).select("_id").lean();
        orderData.conversationId = existingConversation?._id || null;
      }
    } catch (error) {
      console.error("[EBAY] Order conversation-link lookup failed (non-fatal):", error.message || error);
      await logAction({
        action: "system_error",
        status: "failure",
        platform: "ebay",
        entityType: "order",
        message: `Order ${order.orderId}: conversation-link lookup failed`,
        errorMessage: error.message || String(error),
      });
    }

    // Real tracking/carrier data requires a separate call to eBay's
    // shipping_fulfillment sub-resource — the order object itself does not
    // embed it. Best-effort: a failure (including a genuinely trackless
    // order, rate limiting, or an access-denied error) must never block the
    // order itself from being synced. "N/A" is used only after checking —
    // never fabricated in place of a real value.
    orderData.trackingNumber = "N/A";
    orderData.carrier = "N/A";
    orderData.trackingUrl = null;
    try {
      if (account?.accessToken) {
        const fulfillmentResult = await this.client.getShippingFulfillments(account.accessToken, order.orderId);
        const fulfillment = fulfillmentResult?.fulfillments?.[0] || fulfillmentResult;
        const trackingNumber = fulfillment?.shipmentTrackingNumber || fulfillment?.trackingNumber || null;
        const carrier = fulfillment?.shippingCarrierCode || fulfillment?.carrier || null;
        const trackingUrl = fulfillment?.trackingUrl || fulfillment?.shipmentTrackingUrl || null;

        if (trackingNumber) orderData.trackingNumber = trackingNumber;
        if (carrier) orderData.carrier = carrier;
        if (trackingUrl) orderData.trackingUrl = trackingUrl;
      }
    } catch (error) {
      console.error("[EBAY] Order shipping_fulfillment lookup failed (non-fatal):", error.message || error);
    }

    // Filter is scoped by platform + orderId (not orderId alone) so an
    // Amazon order can never overwrite an eBay order sharing the same ID.
    return await Order.findOneAndUpdate(
      { platform: "ebay", orderId: order.orderId },
      orderData,
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );
  }
  
  
  
  // async _upsertOrder(order) {
  //   const orderId = order.orderId;
  //   const buyer = order.buyer || {};
  //   const shippingAddress = buyer.shippingAddress?.addressLine1
  //     ? {
  //         street: buyer.shippingAddress.addressLine1,
  //         city: buyer.shippingAddress.city,
  //         state: buyer.shippingAddress.stateOrProvince,
  //         zip: buyer.shippingAddress.postalCode,
  //         country: buyer.shippingAddress.country,
  //       }
  //     : {};
  //   const lineItem = (order.lineItems || [])[0] || {};

  //   const price = order.pricingSummary?.price?.value
  //     ? parseFloat(order.pricingSummary.price.value)
  //     : 0;
  //   const currency = order.pricingSummary?.price?.currency || "USD";

  //   const leadData = {
  //     marketplace: "ebay",
  //     marketplaceOrderId: orderId,
  //     marketplaceCustomerId: buyer.username,
  //     customerName: buyer.username,
  //     customerEmail: buyer.email,
  //     customerPhone: buyer.contactPhoneNumber,
  //     shippingAddress,
  //     productName: lineItem.title,
  //     productSku: lineItem.sku,
  //     quantity: lineItem.quantity || 1,
  //     price,
  //     currency,
  //     orderStatus: this._mapOrderStatus(order.orderPaymentStatus),
  //     shippingStatus: this._mapShippingStatus(order.fulfillmentStatus),
  //     trackingNumber: lineItem.trackingNumber,
  //     carrier: lineItem.shippingCarrier,
  //     estimatedDelivery: lineItem.estimatedDeliveryDate ? new Date(lineItem.estimatedDeliveryDate) : null,
  //     source: "eBay Sync",
  //   };

  //   // Upsert by marketplaceOrderId to avoid duplicates
  //   let lead = await MarketplaceListing.findOne({
  //     marketplace: "ebay",
  //     marketplaceOrderId: orderId,
  //   });

  //   if (lead) {
  //     Object.assign(lead, leadData);
  //   } else {
  //     lead = new MarketplaceListing(leadData);
  //   }

  //   await lead.save();
  //   return lead;
  // }

  /**
   * Convert a Trading API Listing into the same structure used by
   * the Inventory API.
   */
  _normalizeTradingListing(item) {
    return {
      sku: String(item.SKU || item.ItemID),

      product: {
        title: item.Title || item.SKU || item.ItemID,
        prices: [
          {
            value: item.SellingStatus?.CurrentPrice?.["#text"] || 0,
            currency:
              item.SellingStatus?.CurrentPrice?.currencyID || "USD",
          },
        ],
      },

      availability: {
        shipToLocationAvailability: {
          quantity: Number(item.QuantityAvailable || 0),
        },
      },

      // Real eBay Trading API field (ListingStatusCodeType: Active,
      // Completed, Ended) — used directly in _upsertListing instead of a
      // hardcoded status.
      rawListingStatus: item.SellingStatus?.ListingStatus || null,

      rawTradingData: item,
    };
  }

  /**
   * Map real eBay listing/offer status into the CRM's canonical
   * vocabulary. Sourced only from real eBay fields — never fabricated:
   *   - Trading API's SellingStatus.ListingStatus (Active/Completed/Ended)
   *   - Inventory API Offer's status (PUBLISHED/UNPUBLISHED) — confirmed
   *     via eBay's own API docs to be the field that actually carries
   *     live-listing state; InventoryItem itself has no status field.
   * "Out of Stock" is a data-driven inference (quantity === 0 on an
   * otherwise-active listing), not a raw eBay enum value. Falls back to
   * "Unknown" when neither real field is available — never assumes
   * "Active".
   *
   * @param {Object} params
   * @param {string|null} [params.rawListingStatus] - Trading API value
   * @param {string|null} [params.rawOfferStatus] - Inventory API Offer value
   * @param {number} [params.quantity]
   * @returns {string}
   */
  _normalizeListingStatus({ rawListingStatus, rawOfferStatus, quantity } = {}) {
    if (rawListingStatus) {
      const value = String(rawListingStatus).toUpperCase();
      if (value === "ENDED" || value === "COMPLETED") return "Ended";
      if (value === "ACTIVE") return quantity === 0 ? "Out of Stock" : "Active";
    }

    if (rawOfferStatus) {
      const value = String(rawOfferStatus).toUpperCase();
      if (value === "PUBLISHED") return quantity === 0 ? "Out of Stock" : "Active";
      if (value === "UNPUBLISHED") return "Inactive";
    }

    return "Unknown";
  }

  /**
   * Upsert a MarketplaceListing from an eBay inventory item (listing).
   *
   * @param {Object} item - eBay inventory item from Inventory API (or the
   *   normalized shape from _normalizeTradingListing)
   * @param {Object} [account] - IntegrationAccount document (used for the
   *   best-effort Offer lookup — real price/status for Inventory-API-
   *   sourced items, which don't carry either field themselves)
   * @returns {Promise<Object>} MarketplaceListing document
   */
  async _upsertListing(item, account) {
    const sku = item.sku;
    const product = item.product || {};
    const title = product.title || sku;
    const availability = item.availability?.shipToLocationAvailability || {};
    const priceInfo = product.prices?.[0] || {};
    const quantity = availability.quantity || 0;

    let price = priceInfo.value ? parseFloat(priceInfo.value) : 0;
    let currency = priceInfo.currency || "USD";
    let rawOfferStatus = null;

    // Trading-API-sourced items already have real price (SellingStatus.
    // CurrentPrice) and a real listing status (item.rawListingStatus, set
    // in _normalizeTradingListing) — only Inventory-API-sourced items (no
    // rawListingStatus) need the additional Offer lookup below, since
    // InventoryItem itself carries neither price nor listing status.
    if (!item.rawListingStatus && account?.accessToken) {
      try {
        const offersResult = await this.client.getOffers(account.accessToken, sku);
        const offer = offersResult?.offers?.[0];
        if (offer) {
          rawOfferStatus = offer.status || null;
          const offerPrice = offer.pricingSummary?.price;
          if (offerPrice?.value) {
            price = parseFloat(offerPrice.value);
            currency = offerPrice.currency || currency;
          }
        }
      } catch (error) {
        // Best-effort: a missing/failed offer lookup must never block the
        // listing itself from being synced — falls back to whatever price
        // was already known (likely 0) and "Unknown" status below.
        console.error("[EBAY] Listing offer lookup failed (non-fatal):", error.message || error);
      }
    }

    const listingStatus = this._normalizeListingStatus({
      rawListingStatus: item.rawListingStatus,
      rawOfferStatus,
      quantity,
    });

    const listingData = {
      marketplace: "ebay",
      marketplaceListingId: sku,
      // marketplaceOrderId: null, // This is a listing, not an order
      productName: title,
      productSku: sku,
      quantity,
      price,
      currency,
      listingStatus,
      source: "eBay Listing Sync",
    };

    // Upsert by marketplaceListingId
    let lead = await MarketplaceListing.findOne({
      marketplace: "ebay",
      marketplaceListingId: sku,
      // marketplaceOrderId: null,
    });

    if (lead) {
      Object.assign(lead, listingData);
    } else {
      lead = new MarketplaceListing(listingData);
    }

    await lead.save();
    return lead;
  }

  /**
   * Upsert a Conversation from an eBay message.
   *
   * @param {Object} msg - eBay message object from Messaging API
   * @param {Object} conversationSummary - eBay conversation summary object
   * @param {Object} [account] - IntegrationAccount document (used to detect
   *   whether this message was actually sent by the connected seller, so
   *   historical seller messages aren't mislabeled as customer messages)
   * @returns {Promise<Object>} Conversation document
   */
  async _upsertMessage(msg, conversationSummary, account) {
    const sender = msg.senderUsername || msg.sender?.username || msg.sender || "eBay User";
    const receiver = msg.recipientUsername || msg.recipient?.username || msg.recipient || "Unknown";
    const rawMessage =
      msg.messageBody ||
      msg.message ||
      msg.body ||
      "";

    const messageId =
      msg.messageId ||
      msg.id ||
      msg.message_id ||
      // eBay doesn't always return a stable message ID. Falling back to a
      // random UUID here would mean an ID-less message re-synced later is
      // never recognized as a duplicate. A deterministic hash of its own
      // content means the same message always resolves to the same ID on
      // every future sync, while a genuinely different/new message (even
      // from the same conversation) still gets a new one.
      crypto
        .createHash("sha256")
        .update(`${conversationSummary?.conversationId || ""}|${sender}|${msg.createdDate || msg.timestamp || ""}|${rawMessage}`)
        .digest("hex");

    const cleanedText = rawMessage
      ? convert(rawMessage, {
          wordwrap: 120,
          selectors: [
            { selector: "img", format: "skip" },
            { selector: "style", format: "skip" },
            { selector: "script", format: "skip" },
            { selector: "head", format: "skip" },
            { selector: "a", options: { ignoreHref: true } }
          ]
        })
      : "";

    const text = cleanedText
        .replace(/https?:\/\/\S+/gi, "")           //Remove URLs
        .replace(/\[[^\]]+\]/g, "")                // Remove [https://...]
        .replace(/\n{3,}/g, "\n\n")                // Remove extra blank lines
        .replace(/[ \t]{2,}/g, " ")                // Remove extra spaces
        .trim(); 

    // const text = msg.messageBody || msg.message || msg.body || "";
    const timestamp = 
      msg.createdDate
        ? new Date(msg.createdDate)
        : msg.timestamp 
          ? new Date(msg.timestamp) 
          : new Date();
    // const platformConversationId = msg.conversationId || msg.orderId || messageId;
    const platformConversationId = conversationSummary.conversationId;

    const customerName =
      conversationSummary.buyer?.username ||
      conversationSummary.otherParticipant?.username ||
      msg.senderUsername ||
      msg.recipientUsername ||
      sender ||
      "eBay User";

    // Historical eBay conversations were exchanged before this CRM existed,
    // so a message's true owner must be derived from eBay's own sender
    // identity rather than assumed. Compare the message's actual sender
    // against the connected seller's own eBay username (platformUserId,
    // captured at connect time) — if they match, this is a message the
    // seller/business sent (via eBay's own UI, pre-CRM), not something the
    // customer sent. `senderId` is intentionally left null for these: there
    // is no CRM user to attribute a historical sync message to (a live CRM
    // reply, by contrast, always has a real senderId — see
    // conversation.controller.js#sendReply — which is how the frontend
    // tells "seller/historical" apart from "You").
    const sellerUsername = (account?.platformUserId || "").toLowerCase().trim();
    const isSellerMessage = Boolean(sellerUsername) && String(sender).toLowerCase().trim() === sellerUsername;

    // Find or create conversation
    let conversation = await Conversation.findOne({
      platform: "ebay",
      platformConversationId,
    });

    if (!conversation) {
      conversation = await Conversation.create({
        platform: "ebay",
        platformConversationId,
        platformUserId: customerName,
        customerName: customerName,
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
        senderType: isSellerMessage ? "agent" : "customer",
        senderId: null,
        senderName: isSellerMessage ? (account?.platformName || sender) : sender,
        text,
        messageType: "text",
        createdAt: timestamp,
      });

      conversation.lastMessage = text;
      conversation.lastMessageAt = timestamp;
      conversation.messageCount = conversation.messages.length;
      conversation.updatedAt = new Date();

      conversation.status = "open";
      await conversation.save();
    }

    return conversation;
  }

  /**
   * Map eBay payment status to MarketplaceListing orderStatus.
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
   * Map eBay fulfillment status to MarketplaceListing shippingStatus.
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