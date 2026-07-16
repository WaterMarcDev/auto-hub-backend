/**
 * eBay API Client
 *
 * Reusable HTTP client for all eBay Commerce API interactions.
 * Used by the eBay adapter for OAuth, orders, listings, and messaging.
 *
 * Features:
 *   - Automatic Authorization header injection
 *   - Automatic error normalization (eBay error codes → standard format)
 *   - Rate-limit awareness
 *   - Configurable retry strategy (exponential backoff)
 *   - Configurable timeout
 *   - GET, POST helpers
 *   - OAuth token exchange and refresh
 */
const axios = require("axios");

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, doubles each retry

// ─── Error Classes ──────────────────────────────────────────────────────────

class EbayApiError extends Error {
  constructor(message, statusCode, ebayErrorId = null, isRateLimited = false) {
    super(message);
    this.name = "EbayApiError";
    this.statusCode = statusCode;
    this.ebayErrorId = ebayErrorId;
    this.isRateLimited = isRateLimited;
  }
}

class EbayAuthError extends EbayApiError {
  constructor(message, ebayErrorId = null) {
    super(message, 401, ebayErrorId);
    this.name = "EbayAuthError";
  }
}

class EbayRateLimitError extends EbayApiError {
  constructor(message, retryAfter = null) {
    super(message, 429, null, true);
    this.name = "EbayRateLimitError";
    this.retryAfter = retryAfter;
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

class EbayApiClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.clientId] - eBay App ID (Client ID)
   * @param {string} [options.clientSecret] - eBay Cert ID (Client Secret)
   * @param {string} [options.environment] - "sandbox" or "production"
   * @param {number} [options.timeout] - Request timeout in ms
   * @param {number} [options.maxRetries] - Max retry attempts
   */
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.EBAY_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.EBAY_CLIENT_SECRET;
    this.environment = options.environment || this._detectEnvironment();
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : MAX_RETRIES;
  }

  /**
   * Detect environment from client ID (SBX = sandbox).
   * @returns {string}
   */
  _detectEnvironment() {
    const clientId = this.clientId || "";
    return clientId.includes("-SBX-") || clientId.includes("-sandbox-") ? "sandbox" : "production";
  }

  /**
   * Get the base URL for the eBay API.
   * @returns {string}
   */
  getBaseUrl() {
    if (this.environment === "sandbox") {
      return "https://api.sandbox.ebay.com";
    }
    return "https://api.ebay.com";
  }

  /**
   * Get the base URL for eBay authorization.
   * @returns {string}
   */
  getAuthBaseUrl() {
    if (this.environment === "sandbox") {
      return "https://auth.sandbox.ebay.com/oauth2";
    }
    return "https://auth.ebay.com/oauth2";
  }

  /**
   * Get the sign-in URL for eBay user authorization.
   * @returns {string}
   */
  getSignInUrl() {
    if (this.environment === "sandbox") {
      return "https://signin.sandbox.ebay.com/oauth2/authorize";
    }
    return "https://signin.ebay.com/oauth2/authorize";
  }

  /**
   * Create an axios instance with the given access token.
   * @param {string} accessToken
   * @returns {import('axios').AxiosInstance}
   */
  _createClient(accessToken) {
    const headers = {
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    return axios.create({
      baseURL: this.getBaseUrl(),
      timeout: this.timeout,
      headers,
    });
  }

  /**
   * Create an axios instance for OAuth endpoints (no baseUrl prefix needed).
   * @param {string} [accessToken]
   * @returns {import('axios').AxiosInstance}
   */
  _createAuthClient(accessToken) {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    return axios.create({
      baseURL: this.getAuthBaseUrl(),
      timeout: this.timeout,
      headers,
    });
  }

  /**
   * Normalize an eBay API error into a standard format.
   * @param {Error} err - Axios error
   * @returns {EbayApiError}
   */
  _normalizeError(err) {
    if (err instanceof EbayApiError) return err;

    const statusCode = err.response?.status || 500;
    const body = err.response?.data || {};

    // eBay error structure can vary; try common patterns
    const errors = body.errors || body.error || [];
    const firstError = Array.isArray(errors) ? errors[0] : errors;
    const errorMessage = firstError?.message || firstError?.longMessage || err.message || "eBay API request failed";
    const errorId = firstError?.errorId || firstError?.id || null;

    // Rate limit detection
    if (statusCode === 429) {
      const retryAfter = parseInt(err.response?.headers?.["retry-after"] || "5", 10);
      return new EbayRateLimitError(errorMessage, retryAfter);
    }

    // Auth error detection
    if (statusCode === 401 || statusCode === 403) {
      return new EbayAuthError(errorMessage, errorId);
    }

    return new EbayApiError(errorMessage, statusCode, errorId, false);
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
      if (normalized instanceof EbayAuthError) {
        throw normalized;
      }

      // Retry on rate limit or server errors
      if (
        (normalized instanceof EbayRateLimitError || normalized.statusCode >= 500) &&
        retryCount < this.maxRetries
      ) {
        const delay = normalized instanceof EbayRateLimitError
          ? (normalized.retryAfter || 5) * 1000
          : RETRY_DELAY_MS * Math.pow(2, retryCount);

        console.warn(
          `[EBAY_API] Retry ${retryCount + 1}/${this.maxRetries} after ${delay}ms. ` +
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
   * @param {string} accessToken - eBay access token
   * @param {string} endpoint - API endpoint (e.g., "/sell/fulfillment/v1/order")
   * @param {Object} [params] - Query parameters
   * @returns {Promise<Object>}
   */
  async get(accessToken, endpoint, params = {}) {
    const client = this._createClient(accessToken);
    return this._executeWithRetry(() => client.get(endpoint, { params }));
  }

  /**
   * POST request.
   * @param {string} accessToken - eBay access token
   * @param {string} endpoint - API endpoint
   * @param {Object} [data] - Request body
   * @param {Object} [params] - Query parameters
   * @returns {Promise<Object>}
   */
  async post(accessToken, endpoint, data = {}, params = {}) {
    const client = this._createClient(accessToken);
    return this._executeWithRetry(() => client.post(endpoint, data, { params }));
  }

  // ─── OAuth Operations ────────────────────────────────────────────────────

  /**
   * Generate the eBay OAuth authorization URL.
   *
   * @param {string} ruName - eBay Redirect URL Name (RuName)
   * @param {string} scope - Space-separated OAuth scopes
   * @param {string} [state] - OAuth state parameter for CSRF protection
   * @returns {string} OAuth authorization URL
   */
  getAuthorizationUrl(ruName, scope, state = "") {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: ruName,
      scope,
    });

    if (state) params.set("state", state);

    return `${this.getSignInUrl()}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for an access token and refresh token.
   *
   * eBay OAuth uses Basic Auth with client_id:client_secret for token endpoint.
   *
   * @param {string} code - Authorization code from OAuth callback
   * @param {string} ruName - eBay Redirect URL Name (RuName)
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, tokenType: string}>}
   */
  async exchangeAuthorizationCode(code, ruName) {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    });

    const response = await axios.post(
      `${this.getAuthBaseUrl()}/token`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicAuth}`,
        },
        timeout: this.timeout,
      }
    );

    const data = response.data;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 7200,
      tokenType: data.token_type || "Bearer",
    };
  }

  /**
   * Refresh an expired access token using a refresh token.
   *
   * @param {string} refreshToken - eBay refresh token
   * @param {string} scope - Space-separated OAuth scopes
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
   */
  async refreshAccessToken(refreshToken, scope) {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope,
    });

    const response = await axios.post(
      `${this.getAuthBaseUrl()}/token`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicAuth}`,
        },
        timeout: this.timeout,
      }
    );

    const data = response.data;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in || 7200,
    };
  }

  /**
   * Revoke an access token or refresh token.
   *
   * @param {string} token - Token to revoke
   * @param {string} [tokenType] - "access_token" or "refresh_token"
   * @returns {Promise<boolean>}
   */
  async revokeToken(token, tokenType = "access_token") {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const params = new URLSearchParams({
      token,
      token_type: tokenType,
    });

    try {
      await axios.post(
        `${this.getAuthBaseUrl()}/revoke`,
        params.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basicAuth}`,
          },
          timeout: this.timeout,
        }
      );
      return true;
    } catch (err) {
      console.warn("[EBAY_API] Token revocation warning:", err.message);
      return false;
    }
  }
}

module.exports = {
  EbayApiClient,
  EbayApiError,
  EbayAuthError,
  EbayRateLimitError,
};