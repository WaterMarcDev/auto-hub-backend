/**
 * TikTok API Client
 *
 * Reusable HTTP client for TikTok Login Kit OAuth (v2) and the minimal
 * Basic Display "user info" call. Modeled on ebayApiClient.js / graphApiClient.js.
 *
 * Endpoints below are TikTok's current official Login Kit v2 endpoints
 * (open.tiktokapis.com / www.tiktok.com), confirmed against TikTok for
 * Developers documentation:
 *   - Authorize:      https://www.tiktok.com/v2/auth/authorize/
 *   - Token exchange: POST https://open.tiktokapis.com/v2/oauth/token/
 *   - Token refresh:  POST https://open.tiktokapis.com/v2/oauth/token/ (grant_type=refresh_token)
 *   - Token revoke:   POST https://open.tiktokapis.com/v2/oauth/revoke/
 *   - User info:      GET  https://open.tiktokapis.com/v2/user/info/
 *
 * Only the `user.info.basic` scope is configured for this app, so
 * getUserInfo() only ever requests the fields that scope grants
 * (open_id, union_id, avatar_url, display_name) — no stats/profile/video
 * fields, since those require scopes this app does not have.
 *
 * No marketplace/messaging/lead endpoints exist here — TikTok Login Kit +
 * Webhooks does not provide those capabilities (see tiktokAdapter.js).
 */
const axios = require("axios");

const AUTH_BASE_URL = "https://www.tiktok.com";
const API_BASE_URL = "https://open.tiktokapis.com";
const DEFAULT_TIMEOUT = 30000;

// ─── Error Classes ──────────────────────────────────────────────────────────

class TikTokApiError extends Error {
  constructor(message, statusCode, errorCode = null) {
    super(message);
    this.name = "TikTokApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

class TikTokAuthError extends TikTokApiError {
  constructor(message, errorCode = null) {
    super(message, 401, errorCode);
    this.name = "TikTokAuthError";
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

class TikTokApiClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.clientKey] - TikTok app Client Key
   * @param {string} [options.clientSecret] - TikTok app Client Secret
   * @param {number} [options.timeout]
   */
  constructor(options = {}) {
    this.clientKey = options.clientKey || process.env.TIKTOK_CLIENT_KEY;
    this.clientSecret = options.clientSecret || process.env.TIKTOK_CLIENT_SECRET;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    // Legacy fields kept for compatibility with the original placeholder.
    this.baseUrl = "https://business-api.tiktok.com/open_api/v1.3";
  }

  _normalizeError(err) {
    if (err instanceof TikTokApiError) return err;

    const statusCode = err.response?.status || 500;
    const body = err.response?.data || {};
    const errorMessage =
      body.error?.message ||
      body.error_description ||
      err.message ||
      "TikTok API request failed";
    const errorCode = body.error?.code || body.error || null;

    if (statusCode === 401 || statusCode === 403) {
      return new TikTokAuthError(errorMessage, errorCode);
    }

    return new TikTokApiError(errorMessage, statusCode, errorCode);
  }

  // ─── OAuth Operations ────────────────────────────────────────────────────

  /**
   * Build the TikTok Login Kit authorization URL.
   *
   * @param {string} redirectUri - Must exactly match a redirect URI registered in the TikTok Developer Portal
   * @param {string} scope - Comma-separated scopes (e.g. "user.info.basic")
   * @param {string} [state] - CSRF state parameter
   * @returns {string}
   */
  getAuthorizationUrl(redirectUri, scope, state = "") {
    const params = new URLSearchParams({
      client_key: this.clientKey,
      response_type: "code",
      scope,
      redirect_uri: redirectUri,
    });

    if (state) params.set("state", state);

    return `${AUTH_BASE_URL}/v2/auth/authorize/?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for an access token.
   *
   * @param {string} code
   * @param {string} redirectUri - Must match the redirect_uri used in the authorize step
   * @returns {Promise<{accessToken, refreshToken, expiresIn, refreshExpiresIn, openId, scope, tokenType}>}
   */
  async exchangeAuthorizationCode(code, redirectUri) {
    let response;
    try {
      response = await axios.post(
        `${API_BASE_URL}/v2/oauth/token/`,
        new URLSearchParams({
          client_key: this.clientKey,
          client_secret: this.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cache-Control": "no-cache",
          },
          timeout: this.timeout,
        }
      );
    } catch (err) {
      throw this._normalizeError(err);
    }

    const data = response.data || {};
    if (data.error && data.error !== "" ) {
      // TikTok returns HTTP 200 with an `error` field for some failures.
      throw new TikTokAuthError(data.error_description || "TikTok rejected the authorization code.", data.error);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresIn: data.expires_in,
      refreshExpiresIn: data.refresh_expires_in,
      openId: data.open_id,
      scope: data.scope || "",
      tokenType: data.token_type || "Bearer",
    };
  }

  /**
   * Refresh an expired access token.
   *
   * @param {string} refreshToken
   * @returns {Promise<{accessToken, refreshToken, expiresIn, refreshExpiresIn, openId, scope, tokenType}>}
   */
  async refreshAccessToken(refreshToken) {
    let response;
    try {
      response = await axios.post(
        `${API_BASE_URL}/v2/oauth/token/`,
        new URLSearchParams({
          client_key: this.clientKey,
          client_secret: this.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cache-Control": "no-cache",
          },
          timeout: this.timeout,
        }
      );
    } catch (err) {
      throw this._normalizeError(err);
    }

    const data = response.data || {};
    if (data.error && data.error !== "") {
      throw new TikTokAuthError(data.error_description || "TikTok rejected the refresh token.", data.error);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
      refreshExpiresIn: data.refresh_expires_in,
      openId: data.open_id,
      scope: data.scope || "",
      tokenType: data.token_type || "Bearer",
    };
  }

  /**
   * Revoke an access token.
   *
   * @param {string} token
   * @returns {Promise<boolean>}
   */
  async revokeToken(token) {
    try {
      await axios.post(
        `${API_BASE_URL}/v2/oauth/revoke/`,
        new URLSearchParams({
          client_key: this.clientKey,
          client_secret: this.clientSecret,
          token,
        }).toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: this.timeout,
        }
      );
      return true;
    } catch (err) {
      console.warn("[TIKTOK_API] Token revocation warning:", err.message);
      return false;
    }
  }

  /**
   * Fetch the connected user's basic profile.
   * Only requests fields covered by the `user.info.basic` scope.
   *
   * @param {string} accessToken
   * @returns {Promise<{openId, unionId, avatarUrl, displayName}>}
   */
  async getUserInfo(accessToken) {
    let response;
    try {
      response = await axios.get(`${API_BASE_URL}/v2/user/info/`, {
        params: { fields: "open_id,union_id,avatar_url,display_name" },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: this.timeout,
      });
    } catch (err) {
      throw this._normalizeError(err);
    }

    const body = response.data || {};
    if (body.error && body.error.code && body.error.code !== "ok") {
      throw new TikTokApiError(body.error.message || "TikTok user info request failed", 502, body.error.code);
    }

    const user = body.data?.user || {};
    return {
      openId: user.open_id || null,
      unionId: user.union_id || null,
      avatarUrl: user.avatar_url || null,
      displayName: user.display_name || null,
    };
  }
}

module.exports = { TikTokApiClient, TikTokApiError, TikTokAuthError };
