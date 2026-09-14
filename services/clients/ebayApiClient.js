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
    // An explicit override must itself be valid — an invalid override
    // falls through to env-var detection rather than being trusted as-is.
    const requestedEnv = options.environment ? String(options.environment).toLowerCase().trim() : null;
    this.environment = (requestedEnv === "sandbox" || requestedEnv === "production")
      ? requestedEnv
      : this._detectEnvironment();
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : MAX_RETRIES;
  }

  /**
   * Detect environment strictly from EBAY_ENVIRONMENT.
   *
   * FAIL CLOSED: returns null (never "production", never inferred from the
   * Client ID) when the variable is missing or not exactly "production"/
   * "sandbox". Deliberately does NOT throw here — this runs at
   * construction time, and several call sites construct a client at
   * module-load time (e.g. services/ebay/ebayCatalogSync.service.js's
   * module-level `const client = new EbayApiClient()`); throwing here
   * would crash the whole module (and everything that requires it) just
   * from importing it. Instead, `null` propagates to `this.environment`,
   * and _requireEnvironment() below refuses to resolve any real API URL
   * until a valid environment is set — so an ambiguous environment blocks
   * every actual network call without taking the server down to do it.
   * @returns {string|null}
   */
  _detectEnvironment() {
    const envSetting = (process.env.EBAY_ENVIRONMENT || "").toLowerCase().trim();
    if (envSetting === "sandbox" || envSetting === "production") {
      return envSetting;
    }
    return null;
  }

  /**
   * Throws if this.environment isn't exactly "production" or "sandbox".
   * Every method that resolves a real eBay URL goes through this, so a
   * missing/invalid EBAY_ENVIRONMENT can never silently target production.
   * @returns {string} "production" or "sandbox"
   */
  _requireEnvironment() {
    if (this.environment !== "sandbox" && this.environment !== "production") {
      throw new Error(
        "EBAY_ENVIRONMENT is missing or invalid (must be exactly \"production\" or \"sandbox\") — refusing to guess which eBay environment to call."
      );
    }
    return this.environment;
  }

  /**
   * Get the base URL for the eBay API.
   * @returns {string}
   */
  getBaseUrl() {
    return this._requireEnvironment() === "sandbox"
      ? "https://api.sandbox.ebay.com"
      : "https://api.ebay.com";
  }

  /**
   * Get the base URL for eBay authorization.
   * @returns {string}
   */
  getAuthBaseUrl() {
    return this._requireEnvironment() === "sandbox"
      ? "https://auth.sandbox.ebay.com/oauth2"
      : "https://auth.ebay.com/oauth2";
  }

  /**
   * Get the sign-in URL for eBay user authorization.
   * @returns {string}
   */
  getSignInUrl() {
    return this._requireEnvironment() === "sandbox"
      ? "https://auth.sandbox.ebay.com/oauth2/authorize"
      : "https://auth.ebay.com/oauth2/authorize";
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

      console.log("===== EBAY RAW ERROR =====");
      console.log("Status:", statusCode);
      console.log("Headers:", err.response?.headers);
      console.log("Body:", JSON.stringify(body, null, 2));
      console.log("==================");

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

    // SECURITY: do NOT log `data` directly — it contains the live
    // access_token/refresh_token in plaintext, and this server's console
    // output is persisted to logs/access.log & logs/error.log. A previous
    // version of this function did `console.log(JSON.stringify(data))`
    // here, which wrote both live tokens to disk on every OAuth connect —
    // anyone with log access could have hijacked the eBay seller account.
    // The structured trace log below already reports everything useful
    // (token presence/type/expiry/scope) without the secret values.

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
      scope: data.scope || "",
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
   * Fetch the Offer(s) for a given SKU — the eBay Inventory API's
   * InventoryItem resource does NOT carry price or live-listing status at
   * all (both confirmed absent from InventoryItem in eBay's own API docs);
   * that data lives exclusively on the separate Offer resource returned
   * here (pricingSummary.price, status: PUBLISHED/UNPUBLISHED, and — only
   * for published offers — a `listing` container with the real eBay
   * listing status).
   *
   * Docs: https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffers
   *
   * @param {string} accessToken
   * @param {string} sku
   * @returns {Promise<Object>}
   */
  async getOffers(accessToken, sku) {
    return this.get(accessToken, "/sell/inventory/v1/offer", { sku });
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

  async getConversation(accessToken, conversationId, conversationType, options = {}) {
    const {
      limit = 50,
      offset = 0,
    } = options;

    return this.get(
      accessToken,
      `/commerce/message/v1/conversation/${encodeURIComponent(conversationId)}`,
      {
        conversation_type: conversationType,
        limit,
        offset,
      }
    );
  }

  /**
   * Send a message via eBay's Message API, either within an existing
   * conversation or to start a new one with another eBay user.
   *
   * Docs: https://developer.ebay.com/api-docs/commerce/message/resources/conversation/methods/sendMessage
   * NOTE: eBay's Message API (commerce/message/v1) is documented as a
   * Limited Release API requiring specific eBay approval for production
   * access — this call (and the existing getConversations/getConversation
   * reads) will fail with an access-denied-style error if this eBay
   * developer account has not been granted that access. That is an eBay-side
   * approval gate, not something this client can detect or work around.
   *
   * @param {string} accessToken
   * @param {Object} params
   * @param {string} [params.conversationId] - reply within an existing conversation
   * @param {string} [params.otherPartyUsername] - start a new conversation (unused by this app today)
   * @param {string} params.messageText - message body (required)
   * @returns {Promise<Object>}
   */
  async sendMessage(accessToken, { conversationId, otherPartyUsername, messageText } = {}) {
    const body = { messageText };
    if (conversationId) body.conversationId = conversationId;
    if (otherPartyUsername) body.otherPartyUsername = otherPartyUsername;

    return this.post(accessToken, "/commerce/message/v1/send_message", body);
  }

  /**
   * Generic PUT request helper with retry and auth.
   * @param {string} accessToken
   * @param {string} path - API path (e.g. "/sell/inventory/v1/inventory_item/{sku}")
   * @param {Object} body - Request payload
   * @param {Object} [options] - Extra axios config options
   * @returns {Promise<Object>}
   */
  async put(accessToken, path, body, options = {}) {
    return this._request(accessToken, "put", path, body, options);
  }

  /**
   * Generic DELETE request helper with retry and auth.
   * @param {string} accessToken
   * @param {string} path - API path
   * @param {Object} [options] - Extra axios config options
   * @returns {Promise<Object>}
   */
  async delete(accessToken, path, options = {}) {
    return this._request(accessToken, "delete", path, undefined, options);
  }

  /**
   * Core request method with retry, auth injection, and error normalization.
   * Extracted so PUT/DELETE are handled identically to GET/POST.
   */
  async _request(accessToken, method, path, data = undefined, options = {}) {
    const url = `${this.getBaseUrl()}${path}`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
      ...(options.headers || {}),
    };

    let lastError;
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const config = {
          method,
          url,
          headers,
          timeout: this.timeout,
          ...(data !== undefined ? { data } : {}),
          ...options,
        };
        const response = await axios(config);
        return response.data;
      } catch (err) {
        lastError = err;

        // If it's a rate-limit error, use retry-after header
        if (err.response?.status === 429) {
          const retryAfter = parseInt(err.response.headers?.["retry-after"] || "5", 10);
          console.warn(`[EBAY_CLIENT] Rate limited (429). Retrying after ${retryAfter}s (attempt ${attempt}/${maxAttempts})`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }

        // Retry on network errors or 5xx
        if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.response?.status >= 500) {
          if (attempt < maxAttempts) {
            const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
            console.warn(`[EBAY_CLIENT] Retryable error (attempt ${attempt}/${maxAttempts}). Retrying in ${Math.round(delay)}ms.`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        // Non-retryable or exhausted retries — normalize and throw
        throw classifyEbayError(err);
      }
    }

    throw classifyEbayError(lastError);
  }

/**
   * Fetch the shipping fulfillment(s) for a specific order.
   * Docs: https://developer.ebay.com/api-docs/sell/fulfillment/resources/shipping_fulfillment/methods/getShippingFulfillments
   */
  async getShippingFulfillments(accessToken, orderId) {
    return this.get(
      accessToken,
      `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`
    );
  }

  // ─── Catalog Publishing Methods ──────────────────────────────────────────

  /**
   * Create or replace an inventory item (PUT /inventory_item/{sku}).
   */
  async createOrReplaceInventoryItem(accessToken, sku, body) {
    return this.put(accessToken, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, body);
  }

  /**
   * Get an inventory item by SKU (GET /inventory_item/{sku}).
   */
  async getInventoryItem(accessToken, sku) {
    return this.get(accessToken, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
  }

  /**
   * Create an offer (POST /offer).
   */
  async createOffer(accessToken, body) {
    return this.post(accessToken, "/sell/inventory/v1/offer", body);
  }

  /**
   * Get an offer by offerId (GET /offer/{offerId}).
   */
  async getOffer(accessToken, offerId) {
    return this.get(accessToken, `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  }

  /**
   * Update an offer (PUT /offer/{offerId}).
   */
  async updateOffer(accessToken, offerId, body) {
    return this.put(accessToken, `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, body);
  }

  /**
   * Publish an offer (POST /offer/{offerId}/publish).
   * Returns { listingId: string } on success.
   */
  async publishOffer(accessToken, offerId) {
    return this.post(accessToken, `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {});
  }

  /**
   * Create or replace the vehicle-fitment (Year/Make/Model/Trim) compatibility
   * list for a SKU (PUT /product_compatibility/{sku}). The SKU's inventory
   * item must already exist (createOrReplaceInventoryItem must run first).
   *
   * Docs: https://developer.ebay.com/api-docs/sell/inventory/resources/product_compatibility/methods/createOrReplaceProductCompatibility
   */
  async createOrReplaceProductCompatibility(accessToken, sku, body) {
    return this.put(accessToken, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}/product_compatibility`, body);
  }

  /**
   * Get the current compatibility list for a SKU (GET /product_compatibility/{sku}).
   * Used for post-publish fitment verification.
   */
  async getProductCompatibility(accessToken, sku) {
    return this.get(accessToken, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}/product_compatibility`);
  }

  /**
   * Get all inventory locations (GET /location).
   */
  async getInventoryLocations(accessToken, options = {}) {
    const { limit = 100, offset = 0 } = options;
    return this.get(accessToken, "/sell/inventory/v1/location", { limit, offset });
  }

  /**
   * Create an inventory location (POST /location/{merchantLocationKey}).
   */
  async createInventoryLocation(accessToken, merchantLocationKey, body) {
    return this.post(accessToken, `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`, body);
  }

  /**
   * Get fulfillment policies.
   */
  async getFulfillmentPolicies(accessToken, marketplaceId) {
    return this.get(accessToken, "/sell/account/v1/fulfillment_policy", { marketplace_id: marketplaceId });
  }

  /**
   * Get payment policies.
   */
  async getPaymentPolicies(accessToken, marketplaceId) {
    return this.get(accessToken, "/sell/account/v1/payment_policy", { marketplace_id: marketplaceId });
  }

  /**
   * Get return policies.
   */
  async getReturnPolicies(accessToken, marketplaceId) {
    return this.get(accessToken, "/sell/account/v1/return_policy", { marketplace_id: marketplaceId });
  }
}

module.exports = {
  EbayApiClient,
  EbayApiError,
  EbayAuthError,
  EbayRateLimitError,
};