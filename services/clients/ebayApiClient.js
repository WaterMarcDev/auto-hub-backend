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
const { classifyEbayError } = require("../integrationErrors");

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
   * Detect environment: honor EBAY_ENVIRONMENT when set to a recognized value,
   * otherwise fall back to inferring it from the client ID (SBX = sandbox).
   * @returns {string}
   */
  _detectEnvironment() {
    const envSetting = (process.env.EBAY_ENVIRONMENT || "").toLowerCase().trim();
    if (envSetting === "sandbox" || envSetting === "production") {
      return envSetting;
    }

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
      return "https://auth.sandbox.ebay.com/oauth2/authorize";
    }
    return "https://auth.ebay.com/oauth2/authorize";
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

    const url = `${this.getSignInUrl()}?${params.toString()}`;

    console.log("\n========== EBAY AUTH URL ==========");
    console.log(url);
    console.log("===================================\n");

    return url;

    // return `${this.getSignInUrl()}?${params.toString()}`;
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
  async exchangeAuthorizationCode(code, ruName, traceId = null) {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    });

    const tokenUrl = `${this.getBaseUrl()}/identity/v1/oauth2/token`;

    // ─── DIAGNOSTIC: LOG 5 — before token exchange HTTP call ────────────────
    console.log(JSON.stringify({
      tag: "[EBAY][TRACE]",
      traceId: traceId || "no-trace-id",
      timestamp: new Date().toISOString(),
      platform: "ebay",
      step: "BEFORE_TOKEN_EXCHANGE_HTTP_CALL",
      function: "EbayApiClient.exchangeAuthorizationCode",
      codeLength: code ? code.length : 0,
      tokenUrl,
      hasRuName: Boolean(ruName),
      timeoutMs: this.timeout,
    }));

    let response;
    try {
      response = await axios.post(
        tokenUrl,
        params.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basicAuth}`,
          },
          timeout: this.timeout,
        }
      );
    } catch (err) {
      // ─── DIAGNOSTIC: structured error report — never swallowed ────────────
      console.error(JSON.stringify({
        tag: "[EBAY][ERROR]",
        traceId: traceId || "no-trace-id",
        timestamp: new Date().toISOString(),
        platform: "ebay",
        step: "TOKEN_EXCHANGE_HTTP_CALL_FAILED",
        function: "EbayApiClient.exchangeAuthorizationCode",
        file: __filename,
        message: err?.message,
        code: err?.code,
        cause: err?.cause ? String(err.cause) : null,
        isAxiosError: Boolean(err?.isAxiosError),
        axiosRequest: { method: "post", url: tokenUrl, timeoutMs: this.timeout },
        axiosResponseStatus: err?.response?.status ?? null,
        axiosResponseBody: err?.response?.data ?? null,
        stack: err?.stack,
      }));
      throw classifyEbayError(err);
    }

    const data = response.data;

    // ─── DIAGNOSTIC: LOG 6 — after token exchange HTTP call ─────────────────
    console.log(JSON.stringify({
      tag: "[EBAY][TRACE]",
      traceId: traceId || "no-trace-id",
      timestamp: new Date().toISOString(),
      platform: "ebay",
      step: "AFTER_TOKEN_EXCHANGE_HTTP_CALL",
      function: "EbayApiClient.exchangeAuthorizationCode",
      httpStatus: response.status,
      accessTokenReceived: Boolean(data.access_token),
      refreshTokenReceived: Boolean(data.refresh_token),
      expiresIn: data.expires_in,
      scope: data.scope,
      tokenType: data.token_type,
    }));

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

    let response;
    try {
      response = await axios.post(
        `${this.getBaseUrl()}/identity/v1/oauth2/token`,
        params.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basicAuth}`,
          },
          timeout: this.timeout,
        }
      );
    } catch (err) {
      throw classifyEbayError(err);
    }

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
        `${this.getBaseUrl()}/identity/v1/oauth2/revoke`,
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

  /**
   * Fetch seller orders from eBay Fulfillment API.
   * 
   * Docs:
   * https://developer/ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders
   * 
   * @param {string} accessToken
   * @param {Object} [options]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @param {string} [options.filter]
   * @param {string} [options.sort]
   * @returns {Promise<Object>}
   */
  async getOrders(accessToken, options = {}) {
    const {
      limit = 50,
      offset = 0,
      filter,
      sort,
    } = options;

    const params = {
      limit,
      offset,
    };
    
    if (filter) {
      params.filter = filter;
    }

    if (sort) {
      params.sort = sort;
    }

    return this.get(
      accessToken,
      "/sell/fulfillment/v1/order",
      params
    );
  }

  /**
   * Fetch seller inventory listings
   */
  async getListings(accessToken, options = {}) {
    const {
      limit = 100,
      offset = 0,
    } = options;

    return this.get(
      accessToken,
      "/sell/inventory/v1/inventory_item",
      {
        limit,
        offset,
      }
    );
  }

  /**
 * Fetch seller conversations from eBay Message API
 */
  async getConversations(accessToken, options = {}) {
      const {
          limit = 25,
          offset = 0,
      } = options;

      return this.get(
          accessToken,
          "/commerce/message/v1/conversation",
          {
              limit,
              offset,
          }
      );
}

}


module.exports = {
  EbayApiClient,
  EbayApiError,
  EbayAuthError,
  EbayRateLimitError,
};