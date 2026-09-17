/**
 * TikTok Platform Adapter
 *
 * Implements the BaseAdapter interface for TikTok Login Kit + Webhooks.
 *
 * Scope of what this app is actually configured for (per the TikTok
 * Developer Portal): Login Kit + Webhooks products, `user.info.basic`
 * scope only. There is no Lead Generation / Business API access
 * configured, so this adapter does not implement sendMessage,
 * fetchMessages, fetchOrders, fetchListings, or fetchProfile beyond the
 * OAuth identity fields — those would require API access this app does
 * not have. BaseAdapter's default "not implemented" behavior is left in
 * place for all of them, so adding a Lead Generation adapter later (once
 * that access is granted) only means implementing more methods on this
 * same class — no OAuth/registry rework needed.
 *
 * Handles:
 *   - OAuth connection (authorization URL, token exchange, refresh, revoke)
 *   - Webhook signature verification + `authorization.removed` handling
 *   - Health checks
 *
 * Self-registers with PlatformManager on require().
 */
const crypto = require("crypto");
const BaseAdapter = require("./baseAdapter");
const { TikTokApiClient, TikTokAuthError } = require("../clients/tiktokApiClient");
const platformManager = require("../platformManager.service");
const IntegrationAccount = require("../../models/integrationAccount.model");
const { logAction } = require("../auditLog.service");

// Only request the scope actually enabled in the TikTok Developer Portal.
// Do not add user.info.stats / user.info.profile / video.list here unless
// that access is genuinely enabled and needed.
const DEFAULT_SCOPE = "user.info.basic";

// Webhook signature timestamp tolerance — reject events whose timestamp is
// further from "now" than this, to mitigate replay attacks (the timestamp
// is part of the signed payload, so an attacker cannot alter it without
// invalidating the signature; this window just bounds how old/futuristic a
// still-validly-signed event may be before we refuse to act on it).
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

class TikTokAdapter extends BaseAdapter {
  constructor() {
    super("tiktok");

    this.clientKey = process.env.TIKTOK_CLIENT_KEY;
    this.clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    this.redirectUri = process.env.TIKTOK_REDIRECT_URI || null;
    this.scope = process.env.TIKTOK_SCOPES || DEFAULT_SCOPE;

    this.client = new TikTokApiClient({
      clientKey: this.clientKey,
      clientSecret: this.clientSecret,
    });
  }

  // ─── OAuth ──────────────────────────────────────────────────────────────

  /**
   * Generate the TikTok Login Kit authorization URL.
   *
   * @param {Object} [options]
   * @param {string} [options.redirectUri] - Override redirect URI (platformOAuth.controller.js
   *   always passes the live request's own callback URL here — this is the
   *   normal path; the constructor's env var is only a fallback for contexts
   *   without a request, e.g. manual testing)
   * @param {string} [options.state] - OAuth state parameter (CSRF protection)
   * @returns {Promise<string>}
   */
  async connect(options = {}) {
    if (!this.clientKey) {
      const err = new Error("TIKTOK_CLIENT_KEY is missing from the server environment. Configure your TikTok Developer App credentials in the backend .env file.");
      err.code = "TIKTOK_NOT_CONFIGURED";
      err.statusCode = 500;
      throw err;
    }

    const redirectUri = options.redirectUri || this.redirectUri;
    if (!redirectUri) {
      const err = new Error("No redirect URI available for TikTok OAuth (neither request-derived nor TIKTOK_REDIRECT_URI).");
      err.code = "TIKTOK_REDIRECT_URI_MISSING";
      err.statusCode = 500;
      throw err;
    }

    const scope = options.scope || this.scope;
    const state = options.state || "";

    return this.client.getAuthorizationUrl(redirectUri, scope, state);
  }

  /**
   * Exchange an authorization code for tokens.
   *
   * @param {string} code
   * @param {Object} [options]
   * @param {string} [options.redirectUri] - Must match the URI used in connect()
   * @returns {Promise<{accessToken, refreshToken, expiresIn, tokenType, scope}>}
   */
  async exchangeAuthorizationCode(code, options = {}) {
    if (!this.clientKey || !this.clientSecret) {
      const err = new Error("TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET is missing from the server environment.");
      err.code = "TIKTOK_NOT_CONFIGURED";
      err.statusCode = 500;
      throw err;
    }

    const redirectUri = options.redirectUri || this.redirectUri;
    if (!redirectUri) {
      const err = new Error("No redirect URI available for TikTok token exchange.");
      err.code = "TIKTOK_REDIRECT_URI_MISSING";
      err.statusCode = 500;
      throw err;
    }

    const result = await this.client.exchangeAuthorizationCode(code, redirectUri);

    // Stash the TikTok open_id off to the side — handleCallback() doesn't
    // pass adapter-specific fields back into the IntegrationAccount, but
    // fetchBusinessAccount() (called right after, in the same request) needs
    // the access token, which it already has via the saved account. No
    // action needed here beyond returning the standard token shape.

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
      const err = new Error("No refresh token is available for this TikTok connection. Reconnect TikTok from Platform Connections.");
      err.code = "TIKTOK_MISSING_REFRESH_TOKEN";
      err.statusCode = 400;
      throw err;
    }

    const result = await this.client.refreshAccessToken(account.refreshToken);

    account.accessToken = result.accessToken;
    if (result.refreshToken) account.refreshToken = result.refreshToken;
    account.tokenExpiresAt = result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1000)
      : account.tokenExpiresAt;
    account.lastSyncAt = new Date();
    await account.save();

    await logAction({
      action: "token_refreshed",
      status: "success",
      platform: "tiktok",
      entityType: "integration_account",
      entityId: account._id,
      message: "TikTok access token refreshed successfully",
    });

    return account;
  }

  // ─── Disconnect ────────────────────────────────────────────────────────

  /**
   * Disconnect and revoke token access.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<boolean>}
   */
  async disconnect(account) {
    if (account.accessToken) {
      await this.client.revokeToken(account.accessToken);
    }

    account.isActive = false;
    account.isConnected = false;
    account.accessToken = null;
    account.refreshToken = null;
    account.tokenExpiresAt = null;
    // accessToken is required on the shared IntegrationAccount schema, so
    // full validation must be skipped for this save (same reasoning as
    // ebayAdapter.disconnect()).
    await account.save({ validateBeforeSave: false });

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: "tiktok",
      entityType: "integration_account",
      entityId: account._id,
      message: "TikTok disconnected successfully",
    });

    return true;
  }

  // ─── Business Account / Profile ────────────────────────────────────────

  /**
   * Fetch the connected TikTok user's basic profile and persist identity
   * fields onto the IntegrationAccount. TikTok Login Kit has no concept of
   * a separate "business account" the way Meta/eBay do — this reuses the
   * existing generic interface (called unconditionally by
   * platformOAuth.controller.js after every OAuth connect) to store the
   * TikTok user's open_id/display_name/avatar instead.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{businessAccountId: string, businessName: string}>}
   */
  async fetchBusinessAccount(account) {
    try {
      const userInfo = await this.client.getUserInfo(account.accessToken);

      account.platformUserId = userInfo.openId || account.platformUserId;
      account.platformName = userInfo.displayName || "TikTok User";
      account.metadata = {
        ...account.metadata,
        unionId: userInfo.unionId,
        avatarUrl: userInfo.avatarUrl,
      };
      await account.save();

      return {
        businessAccountId: userInfo.openId || account._id.toString(),
        businessName: userInfo.displayName || "TikTok User",
      };
    } catch (err) {
      console.warn("[TIKTOK] fetchBusinessAccount warning:", err.message);
      return {
        businessAccountId: account._id.toString(),
        businessName: "TikTok User",
      };
    }
  }

  /**
   * Not applicable for TikTok Login Kit.
   */
  async fetchPhoneNumber() {
    return [];
  }

  // ─── Health Check ──────────────────────────────────────────────────────

  /**
   * Verify the TikTok connection by calling the user info endpoint —
   * cheap, covered by the granted user.info.basic scope, and an actual
   * network round-trip (not just local expiry-time inspection), so a
   * revoked-on-TikTok's-side token is correctly reported unhealthy even
   * before our locally-stored tokenExpiresAt would say so.
   *
   * @param {Object} account - IntegrationAccount document
   * @returns {Promise<{healthy: boolean, details: Object}>}
   */
  async healthCheck(account) {
    if (!account.accessToken) {
      return { healthy: false, details: { healthy: false, error: "No TikTok access token stored" } };
    }

    try {
      const userInfo = await this.client.getUserInfo(account.accessToken);
      return {
        healthy: true,
        details: {
          healthy: true,
          openId: userInfo.openId,
          displayName: userInfo.displayName,
        },
      };
    } catch (err) {
      const isAuthError = err instanceof TikTokAuthError;
      return {
        healthy: false,
        details: {
          healthy: false,
          error: err.message,
          isAuthError,
        },
      };
    }
  }

  // ─── Webhook ────────────────────────────────────────────────────────────

  /**
   * TikTok's Webhooks product has no GET challenge/handshake step (unlike
   * Meta's hub.challenge) — the callback URL is registered directly in the
   * TikTok Developer Portal, which verifies it with a POST test event
   * instead. Matches ebayAdapter.verifyWebhook()'s idiom for platforms that
   * don't use this verb.
   */
  verifyWebhook() {
    return { verified: false, challenge: null };
  }

  /**
   * TikTok does not expose a documented API to register the webhook
   * callback URL programmatically — it's configured once in the Developer
   * Portal UI (already done for this app, per the task's own setup notes).
   * Deliberate no-op, matching ebayAdapter.registerWebhook()'s pattern for
   * platforms whose webhook config lives outside the OAuth flow.
   */
  async registerWebhook() {
    console.log("[TIKTOK] Webhook registration not implemented — callback URL is configured in the TikTok Developer Portal");
    return false;
  }

  /**
   * Verify a TikTok webhook request's `Tiktok-Signature` header.
   *
   * Per TikTok's webhook verification documentation, the header has the
   * form `t=<unix timestamp>,s=<hex HMAC-SHA256 signature>`. The signature
   * is HMAC-SHA256(key = TIKTOK_CLIENT_SECRET, message = `${timestamp}.${rawBody}`),
   * hex-encoded. This is a *different* scheme from TikTok Shop's webhook
   * signing (which signs `app_key + raw_body` into an `Authorization`
   * header) — this app has the generic "Webhooks" product, not TikTok Shop,
   * so this is the correct scheme for it.
   *
   * @param {string} signatureHeader - raw `Tiktok-Signature` header value
   * @param {Buffer|string} rawBody - the exact bytes TikTok sent (not the parsed/re-serialized JSON)
   * @returns {{valid: boolean, reason?: string}}
   */
  verifyWebhookSignature(signatureHeader, rawBody) {
    if (!this.clientSecret) {
      return { valid: false, reason: "TIKTOK_CLIENT_SECRET is not configured" };
    }
    if (!signatureHeader || typeof signatureHeader !== "string") {
      return { valid: false, reason: "Missing Tiktok-Signature header" };
    }
    if (rawBody === undefined || rawBody === null) {
      return { valid: false, reason: "Missing raw request body" };
    }

    const parts = {};
    for (const segment of signatureHeader.split(",")) {
      const [key, value] = segment.split("=");
      if (key && value !== undefined) parts[key.trim()] = value.trim();
    }

    const timestamp = parts.t;
    const signature = parts.s;

    if (!timestamp || !signature) {
      return { valid: false, reason: "Malformed Tiktok-Signature header" };
    }

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
    if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
      return { valid: false, reason: "Webhook timestamp outside acceptable tolerance" };
    }

    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
    const signedPayload = `${timestamp}.${bodyString}`;
    const expectedSignature = crypto
      .createHmac("sha256", this.clientSecret)
      .update(signedPayload, "utf8")
      .digest("hex");

    let signaturesMatch = false;
    try {
      signaturesMatch =
        expectedSignature.length === signature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSignature, "utf8"), Buffer.from(signature, "utf8"));
    } catch {
      signaturesMatch = false;
    }

    if (!signaturesMatch) {
      return { valid: false, reason: "Signature mismatch" };
    }

    return { valid: true };
  }

  /**
   * Process an incoming TikTok webhook event.
   *
   * @param {Object} payload - parsed JSON body
   * @param {Object} [meta]
   * @param {Object} [meta.headers] - raw request headers (for signature verification)
   * @param {Buffer} [meta.rawBody] - raw request body bytes (for signature verification)
   * @returns {Promise<Object>}
   */
  async processWebhook(payload, meta = {}) {
    const headers = meta.headers || {};
    const signatureHeader = headers["tiktok-signature"] || headers["Tiktok-Signature"];

    const verification = this.verifyWebhookSignature(signatureHeader, meta.rawBody);
    if (!verification.valid) {
      await logAction({
        action: "webhook_failed",
        status: "failure",
        platform: "tiktok",
        message: `TikTok webhook signature verification failed: ${verification.reason}`,
        metadata: { reason: verification.reason },
      });
      // Never process an unverified payload — but still resolve (not throw)
      // so platformWebhook.controller.js can return its normal 200 ack
      // without treating this as a transport-level failure.
      return { processed: false, verified: false, reason: verification.reason };
    }

    const event = payload?.event;

    // Only dispatch event types actually confirmed in TikTok's current
    // webhook documentation for the products this app has enabled
    // (Login Kit + Webhooks). Anything else is logged and safely ignored
    // rather than guessed at.
    if (event === "authorization.removed") {
      return this._handleAuthorizationRemoved(payload);
    }

    console.log(`[TIKTOK] Webhook event received (no handler registered): ${event || "unknown"}`);
    await logAction({
      action: "webhook_received",
      status: "warning",
      platform: "tiktok",
      message: `TikTok webhook received with unhandled event type: ${event || "unknown"}`,
      metadata: { event },
    });

    return { processed: false, verified: true, event: event || "unknown" };
  }

  async receiveWebhook(payload, meta = {}) {
    return this.processWebhook(payload, meta);
  }

  /**
   * Handle `authorization.removed` — TikTok's notification that the user
   * revoked this app's access on TikTok's side. Idempotent: marking an
   * already-disconnected account as disconnected again is a harmless no-op,
   * so no separate event-dedup ledger is needed (mirrors how other adapters
   * in this codebase dedupe at the data layer, e.g. ebayAdapter._upsertMessage's
   * platformMessageId check, rather than via a generic webhook-event log).
   *
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async _handleAuthorizationRemoved(payload) {
    const openId = payload?.user_openid;

    if (!openId) {
      return { processed: false, verified: true, event: "authorization.removed", reason: "Missing user_openid in payload" };
    }

    const account = await IntegrationAccount.findOne({
      platform: "tiktok",
      platformUserId: openId,
    }).sort({ createdAt: -1 });

    if (!account) {
      // Nothing to do locally — the event still verified correctly.
      return { processed: true, verified: true, event: "authorization.removed", matchedAccount: false };
    }

    if (account.isConnected || account.isActive) {
      account.isActive = false;
      account.isConnected = false;
      account.accessToken = null;
      account.refreshToken = null;
      account.tokenExpiresAt = null;
      await account.save({ validateBeforeSave: false });

      await logAction({
        action: "platform_disconnected",
        status: "success",
        platform: "tiktok",
        entityType: "integration_account",
        entityId: account._id,
        message: "TikTok connection removed by user (authorization.removed webhook)",
      });
    }

    return { processed: true, verified: true, event: "authorization.removed", matchedAccount: true };
  }
}

// ─── Self-Registration ──────────────────────────────────────────────────────
// Registers the TikTok adapter with PlatformManager on require().
// Follows the same pattern as whatsappAdapter.js / ebayAdapter.js.

const instance = new TikTokAdapter();
platformManager.registerAdapter("tiktok", instance);
console.log("[TIKTOK] TikTok adapter registered with PlatformManager");

module.exports = instance;
