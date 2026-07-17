/**
 * Meta Platform Adapter
 *
 * Shared abstract adapter for all Meta platforms (Facebook, Instagram, WhatsApp).
 *
 * Contains all common Meta Graph API logic to prevent code duplication:
 *   - OAuth URL generation
 *   - Authorization code exchange
 *   - Long-lived token exchange
 *   - Webhook verification and registration
 *   - Business account fetching
 *   - Phone number fetching
 *   - Token validation
 *   - Health checks
 *   - Error normalization
 *
 * Subclasses (facebookAdapter, instagramAdapter, whatsappAdapter) only need to
 * implement platform-specific logic: sendMessage, fetchMessages, etc.
 */
const BaseAdapter = require("./baseAdapter");
const { GraphApiClient, GraphApiAuthError } = require("../clients/graphApiClient");
const { logAction } = require("../auditLog.service");

const DEFAULT_SCOPE = [
  "whatsapp_business_messaging",
  "whatsapp_business_management",
  "business_management",
  "pages_manage_metadata",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_messages",
];

class MetaAdapter extends BaseAdapter {
  /**
   * @param {string} platformName - "facebook", "instagram", or "whatsapp"
   * @param {Object} [options]
   * @param {string} [options.graphVersion] - Meta Graph API version
   * @param {Array} [options.scope] - OAuth scopes for this platform
   */
  constructor(platformName, options = {}) {
    super(platformName);
    this.client = new GraphApiClient({
      baseUrl: `https://graph.facebook.com/${options.graphVersion || process.env.META_GRAPH_VERSION || "v23.0"}`,
    });
    this.scope = options.scope || DEFAULT_SCOPE;
    this.appId = process.env.META_APP_ID;
    this.appSecret = process.env.META_APP_SECRET;
    this.redirectUri = process.env.META_REDIRECT_URI;
    this.verifyToken = process.env.META_VERIFY_TOKEN;
  }

  // ─── OAuth ──────────────────────────────────────────────────────────────

  /**
   * Generate the Meta OAuth authorization URL.
   * The user is redirected here to grant permissions.
   *
   * @param {Object} [options]
   * @param {string} [options.redirectUri] - Override redirect URI
   * @param {Array} [options.scope] - Override OAuth scopes
   * @param {string} [options.state] - OAuth state parameter for CSRF protection
   * @returns {Promise<string>} OAuth authorization URL
   */
  async connect(options = {}) {
    const redirectUri = options.redirectUri || this.redirectUri;
    const scope = options.scope || this.scope;
    const state = options.state || "";

    //----------------------------------------------------
    // BUGFIX
    // Return structured error with code instead of generic message.
    //----------------------------------------------------
    if (!this.appId) {
      console.error(`[MetaAdapter] Environment variable META_APP_ID not found. Check .env configuration.`);
      const err = new Error("META_APP_ID is missing from the server environment. Configure your Meta Developer App credentials in the backend .env file.");
      err.code = "META_APP_NOT_CONFIGURED";
      err.statusCode = 500;
      throw err;
    }

    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: redirectUri,
      scope: scope.join(","),
      response_type: "code",
    });

    if (state) params.set("state", state);

    return `https://www.facebook.com/v23.0/dialog/oauth?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for an access token.
   *
   * @param {string} code - Authorization code from OAuth callback
   * @param {Object} [options]
   * @param {string} [options.redirectUri] - Must match the original redirect URI
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
   */
  async exchangeAuthorizationCode(code, options = {}) {
    const redirectUri = options.redirectUri || this.redirectUri;

    if (!this.appId || !this.appSecret) {
      console.error(`[MetaAdapter] Environment variable META_APP_ID or META_APP_SECRET not found. Check .env configuration.`);
      const err = new Error("META_APP_ID is missing from the server environment. Configure your Meta Developer App credentials in the backend .env file.");
      err.code = "META_APP_NOT_CONFIGURED";
      err.statusCode = 500;
      throw err;
    }

    const result = await this.client.exchangeAuthorizationCode(
      this.appId,
      this.appSecret,
      code,
      redirectUri
    );

    // Exchange short-lived token for long-lived token
    const longLived = await this.client.exchangeLongLivedToken(
      this.appId,
      this.appSecret,
      result.accessToken
    );

    return {
      accessToken: longLived.accessToken,
      refreshToken: null, // Meta doesn't use refresh tokens; long-lived tokens last 60 days
      expiresIn: longLived.expiresIn,
    };
  }

  // ─── Token Management ──────────────────────────────────────────────────

  /**
   * Refresh an expired token by exchanging for a new long-lived token.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<Object>} Updated account
   */
  async refreshToken(account) {
    if (!account.accessToken) {
      throw new Error("No access token to refresh");
    }

    // Check if token is still valid first
    const isValid = await this.healthCheck(account);

    if (isValid.healthy) {
      // Token is still valid, just update the expiry
      // Meta tokens last 60 days; extend if near expiry
      const longLived = await this.client.exchangeLongLivedToken(
        this.appId,
        this.appSecret,
        account.accessToken
      );

      account.accessToken = longLived.accessToken;
      account.tokenExpiresAt = new Date(Date.now() + longLived.expiresIn * 1000);
      account.lastSyncAt = new Date();
      await account.save();

      await logAction({
        action: "token_refreshed",
        status: "success",
        platform: this.platformName,
        entityType: "integration_account",
        entityId: account._id,
        message: `Token refreshed for ${this.platformName}`,
      });

      return account;
    }

    throw new Error(`Token refresh failed for ${this.platformName}: token is invalid`);
  }

  // ─── Webhook ────────────────────────────────────────────────────────────

  /**
   * Verify a webhook request from Meta.
   * Meta sends GET requests with hub.mode, hub.challenge, hub.verify_token.
   *
   * @param {Object} query - Query parameters from the webhook GET request
   * @returns {{ verified: boolean, challenge: number|null }}
   */
  verifyWebhook(query) {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === this.verifyToken) {
      return { verified: true, challenge: parseInt(challenge, 10) || challenge };
    }

    return { verified: false, challenge: null };
  }

  /**
   * Register a webhook subscription for this app.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<boolean>}
   */
  async registerWebhook(account) {
    if (!this.appId || !this.appSecret) {
      throw new Error("META_APP_ID and META_APP_SECRET must be configured");
    }

    const appAccessToken = `${this.appId}|${this.appSecret}`;

    // Determine the fields based on platform
    const fields = this._getWebhookFields();

    try {
      await this.client.post(account.accessToken, `/${this.appId}/subscriptions`, {
        object: this._getWebhookObject(),
        fields: fields.join(","),
        callback_url: `${process.env.API_BASE_URL || ""}/api/integrations/${this.platformName}/webhook`,
        verify_token: this.verifyToken,
      });

      account.webhookVerified = true;
      account.webhookLastPing = new Date();
      account.webhookConfig = { fields, object: this._getWebhookObject() };
      await account.save();

      await logAction({
        action: "webhook_registered",
        status: "success",
        platform: this.platformName,
        entityType: "integration_account",
        entityId: account._id,
        message: `Webhook registered for ${this.platformName}`,
      });

      return true;
    } catch (err) {
      await logAction({
        action: "webhook_registration_failed",
        status: "failure",
        platform: this.platformName,
        entityType: "integration_account",
        entityId: account._id,
        message: `Webhook registration failed: ${err.message}`,
        errorMessage: err.message,
      });

      throw err;
    }
  }

  /**
   * Get the webhook object name for this platform.
   * @returns {string}
   * @protected
   */
  _getWebhookObject() {
    return "whatsapp_business_account"; // Override in subclasses
  }

  /**
   * Get the webhook fields to subscribe to.
   * @returns {string[]}
   * @protected
   */
  _getWebhookFields() {
    return ["messages", "message_deliveries", "message_reads"];
  }

  // ─── Business Account ──────────────────────────────────────────────────

  /**
   * Fetch the WhatsApp Business Account ID.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{businessAccountId: string, businessName: string}>}
   */
  async fetchBusinessAccount(account) {
    // First, get the user's businesses
    const meResult = await this.client.get(account.accessToken, "/me/businesses");

    const businesses = meResult.data || [];
    if (businesses.length === 0) {
      throw new Error("No Meta Business Account found. Please create one at https://business.facebook.com");
    }

    // Use the first business account
    const business = businesses[0];
    account.platformBusinessId = business.id;

    // Store the business name in metadata
    account.metadata = {
      ...account.metadata,
      businessName: business.name,
    };

    await account.save();

    return {
      businessAccountId: business.id,
      businessName: business.name,
    };
  }

  /**
   * Fetch phone number(s) associated with the WhatsApp Business Account.
   * Override in subclasses for platform-specific logic.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<Array<{phoneNumberId: string, displayPhoneNumber: string}>>}
   */
  async fetchPhoneNumber(account) {
    throw new Error(`fetchPhoneNumber() must be implemented by ${this.platformName} adapter`);
  }

  // ─── Health Check ──────────────────────────────────────────────────────

  /**
   * Check if the Meta API connection is healthy.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{healthy: boolean, details: Object}>}
   */
  async healthCheck(account) {
    try {
      // Simple test: call /me endpoint
      const result = await this.client.get(account.accessToken, "/me", {
        fields: "id,name",
      });

      return {
        healthy: true,
        details: {
          userId: result.id,
          userName: result.name,
          platform: this.platformName,
        },
      };
    } catch (err) {
      const isAuthError = err instanceof GraphApiAuthError;

      return {
        healthy: false,
        details: {
          error: err.message,
          isAuthError,
          errorCode: err.metaErrorCode,
          platform: this.platformName,
        },
      };
    }
  }

  // ─── Disconnect ────────────────────────────────────────────────────────

  /**
   * Disconnect and revoke the app's access.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<boolean>}
   */
  async disconnect(account) {
    try {
      // Revoke the token
      await this.client.delete(account.accessToken, `/me/permissions`);
    } catch (err) {
      // Log but don't fail — token may already be invalid
      console.warn(`[${this.platformName.toUpperCase()}] Token revocation warning:`, err.message);
    }

    account.isActive = false;
    account.isConnected = false;
    account.accessToken = null;
    account.refreshToken = null;
    account.tokenExpiresAt = null;
    await account.save();

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: this.platformName,
      entityType: "integration_account",
      entityId: account._id,
      message: `Platform disconnected: ${this.platformName}`,
    });

    return true;
  }

  // ─── Mark as Read ──────────────────────────────────────────────────────

  /**
   * Mark a message as read.
   * Override in subclasses for platform-specific read receipt logic.
   *
   * @param {string} messageId - Platform message ID
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  async markAsRead(messageId, options = {}) {
    throw new Error(`markAsRead() must be implemented by ${this.platformName} adapter`);
  }
}

module.exports = MetaAdapter;