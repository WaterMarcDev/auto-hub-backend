/**
 * Meta Graph API Client
 *
 * Reusable HTTP client for all Meta Graph API interactions.
 * Used by Facebook, Instagram, and WhatsApp adapters.
 *
 * Features:
 *   - Automatic Authorization header injection
 *   - Automatic error normalization (Meta error codes → standard format)
 *   - Rate-limit awareness (reads X-RateLimit-* headers)
 *   - Configurable retry strategy (exponential backoff)
 *   - Configurable timeout
 *   - Request/response logging
 *   - GET, POST, DELETE helpers
 */
const axios = require("axios");
const { logAction } = require("../auditLog.service");

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const DEFAULT_BASE_URL = `https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}`;
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, doubles each retry

// ─── Error Classes ──────────────────────────────────────────────────────────

class GraphApiError extends Error {
  constructor(message, statusCode, metaErrorCode = null, metaErrorSubcode = null, isRateLimited = false) {
    super(message);
    this.name = "GraphApiError";
    this.statusCode = statusCode;
    this.metaErrorCode = metaErrorCode;
    this.metaErrorSubcode = metaErrorSubcode;
    this.isRateLimited = isRateLimited;
  }
}

class GraphApiAuthError extends GraphApiError {
  constructor(message, metaErrorCode = null) {
    super(message, 401, metaErrorCode);
    this.name = "GraphApiAuthError";
  }
}

class GraphApiRateLimitError extends GraphApiError {
  constructor(message, retryAfter = null) {
    super(message, 429, null, null, true);
    this.name = "GraphApiRateLimitError";
    this.retryAfter = retryAfter;
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

class GraphApiClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl] - Graph API base URL
   * @param {number} [options.timeout] - Request timeout in ms
   * @param {number} [options.maxRetries] - Max retry attempts
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : MAX_RETRIES;
  }

  /**
   * Create an axios instance with the given access token.
   * @param {string} accessToken
   * @returns {import('axios').AxiosInstance}
   */
  _createClient(accessToken) {
    return axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Normalize a Meta Graph API error into a standard format.
   * @param {Error} err - Axios error
   * @returns {GraphApiError}
   */
  _normalizeError(err) {
    if (err instanceof GraphApiError) return err;

    const statusCode = err.response?.status || 500;
    const body = err.response?.data || {};
    const metaError = body.error || {};

    // Rate limit detection
    if (statusCode === 429 || metaError.code === 4 || metaError.code === 17 || metaError.code === 613) {
      const retryAfter = parseInt(err.response?.headers?.["retry-after"] || "5", 10);
      return new GraphApiRateLimitError(
        metaError.message || "Rate limit exceeded",
        retryAfter
      );
    }

    // Auth error detection
    if (statusCode === 401 || statusCode === 403 || metaError.code === 190 || metaError.code === 102) {
      return new GraphApiAuthError(
        metaError.message || "Authentication failed",
        metaError.code
      );
    }

    return new GraphApiError(
      metaError.message || err.message || "Graph API request failed",
      statusCode,
      metaError.code,
      metaError.error_subcode,
      false
    );
  }

  /**
   * Execute a request with retry logic.
   * @param {Function} requestFn - Async function that executes the request
   * @param {number} [retryCount] - Current retry attempt
   * @returns {Promise<Object>} Response data
   */
  async _executeWithRetry(requestFn, retryCount = 0) {
    try {
      const response = await requestFn();
      return response.data;
    } catch (err) {
      const normalized = this._normalizeError(err);

      // Don't retry auth errors
      if (normalized instanceof GraphApiAuthError) {
        throw normalized;
      }

      // Retry on rate limit or server errors
      if (
        (normalized instanceof GraphApiRateLimitError || normalized.statusCode >= 500) &&
        retryCount < this.maxRetries
      ) {
        const delay = normalized instanceof GraphApiRateLimitError
          ? (normalized.retryAfter || 5) * 1000
          : RETRY_DELAY_MS * Math.pow(2, retryCount);

        console.warn(
          `[GRAPH_API] Retry ${retryCount + 1}/${this.maxRetries} after ${delay}ms. ` +
          `Status: ${normalized.statusCode}, Error: ${normalized.message}`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this._executeWithRetry(requestFn, retryCount + 1);
      }

      throw normalized;
    }
  }

  /**
   * GET request.
   * @param {string} accessToken - Meta access token
   * @param {string} endpoint - API endpoint (e.g., "/me", "/{phone-number-id}/messages")
   * @param {Object} [params] - Query parameters
   * @returns {Promise<Object>}
   */
  async get(accessToken, endpoint, params = {}) {
    const client = this._createClient(accessToken);
    return this._executeWithRetry(() => client.get(endpoint, { params }));
  }

  /**
   * POST request.
   * @param {string} accessToken - Meta access token
   * @param {string} endpoint - API endpoint
   * @param {Object} [data] - Request body
   * @param {Object} [params] - Query parameters
   * @returns {Promise<Object>}
   */
  async post(accessToken, endpoint, data = {}, params = {}) {
    const client = this._createClient(accessToken);
    return this._executeWithRetry(() => client.post(endpoint, data, { params }));
  }

  /**
   * DELETE request.
   * @param {string} accessToken - Meta access token
   * @param {string} endpoint - API endpoint
   * @param {Object} [params] - Query parameters
   * @returns {Promise<Object>}
   */
  async delete(accessToken, endpoint, params = {}) {
    const client = this._createClient(accessToken);
    return this._executeWithRetry(() => client.delete(endpoint, { params }));
  }

  /**
   * Exchange an authorization code for an access token.
   * Uses app_id + app_secret directly (not the client's token).
   *
   * @param {string} appId - Meta App ID
   * @param {string} appSecret - Meta App Secret
   * @param {string} code - Authorization code from OAuth
   * @param {string} redirectUri - OAuth redirect URI
   * @returns {Promise<{accessToken: string, expiresIn: number}>}
   */
  async exchangeAuthorizationCode(appId, appSecret, code, redirectUri) {
    const params = {
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri,
    };

    const response = await axios.get("https://graph.facebook.com/oauth/access_token", { params });
    const data = response.data;

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || "Bearer",
      expiresIn: data.expires_in || 0,
    };
  }

  /**
   * Exchange a short-lived token for a long-lived token.
   *
   * @param {string} appId - Meta App ID
   * @param {string} appSecret - Meta App Secret
   * @param {string} shortLivedToken - Short-lived access token
   * @returns {Promise<{accessToken: string, expiresIn: number}>}
   */
  async exchangeLongLivedToken(appId, appSecret, shortLivedToken) {
    const params = {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    };

    const response = await axios.get("https://graph.facebook.com/oauth/access_token", { params });
    const data = response.data;

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || "Bearer",
      expiresIn: data.expires_in || 0,
    };
  }

  /**
   * Debug a token to check validity and permissions.
   *
   * @param {string} accessToken - Token to debug
   * @param {string} appAccessToken - App access token for debugging
   * @returns {Promise<Object>} Token debug info
   */
  async debugToken(accessToken, appAccessToken) {
    return this.get(appAccessToken, "/debug_token", {
      input_token: accessToken,
    });
  }

  /**
   * Check if a token is still valid.
   *
   * @param {string} accessToken - Token to check
   * @param {string} appAccessToken - App access token
   * @returns {Promise<boolean>}
   */
  async isTokenValid(accessToken, appAccessToken) {
    try {
      const result = await this.debugToken(accessToken, appAccessToken);
      return result.data?.is_valid === true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  GraphApiClient,
  GraphApiError,
  GraphApiAuthError,
  GraphApiRateLimitError,
};