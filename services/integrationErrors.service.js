/**
 * Integration Error Taxonomy
 *
 * Categorizes OAuth/platform-integration failures into a consistent shape
 * instead of letting raw Mongoose/axios errors leak to the client as a
 * generic 500. Each IntegrationError carries: a category, a user-readable
 * message, a developer-facing detail, a recovery suggestion, and whether
 * retrying is expected to help.
 *
 * Currently wired into the eBay OAuth path only (classifyEbayError). Other
 * platforms keep their existing error handling untouched.
 */

const CATEGORIES = {
  INVALID_CREDENTIALS: "invalid_credentials",
  REDIRECT_URI_MISMATCH: "redirect_uri_mismatch",
  MISSING_SCOPES: "missing_scopes",
  MISSING_REFRESH_TOKEN: "missing_refresh_token",
  TOKEN_EXPIRED: "token_expired",
  NETWORK_TIMEOUT: "network_timeout",
  RATE_LIMITED: "rate_limited",
  PERMISSION_DENIED: "permission_denied",
  INVALID_CALLBACK: "invalid_callback",
  MISSING_ENV_VARS: "missing_env_vars",
  UNKNOWN: "unknown",
};

class IntegrationError extends Error {
  constructor({ category, message, detail, recoverySuggestion, retryable = false, statusCode = 500, cause }) {
    super(message);
    this.name = "IntegrationError";
    this.category = category;
    this.detail = detail || message;
    this.recoverySuggestion = recoverySuggestion || null;
    this.retryable = retryable;
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      success: false,
      category: this.category,
      message: this.message,
      detail: this.detail,
      recoverySuggestion: this.recoverySuggestion,
      retryable: this.retryable,
    };
  }
}

/**
 * Classify a raw error (axios error from eBay's API, or a thrown Error from
 * our own adapter code) into an IntegrationError with a specific category.
 */
function classifyEbayError(err) {
  if (err instanceof IntegrationError) return err;

  const status = err?.response?.status ?? err?.statusCode ?? null;
  const body = err?.response?.data;
  const ebayErrorText = JSON.stringify(body?.errors || body?.error_description || body?.error || "").toLowerCase();
  const code = err?.code;

  // Missing environment / config — thrown deliberately by ebayAdapter.js
  if (code === "EBAY_NOT_CONFIGURED" || code === "EBAY_RUNAME_MISSING") {
    return new IntegrationError({
      category: CATEGORIES.MISSING_ENV_VARS,
      message: "eBay integration is not fully configured on the server.",
      detail: err.message,
      recoverySuggestion: "Check EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RUNAME in the backend environment.",
      retryable: false,
      statusCode: 500,
      cause: err,
    });
  }

  // Network-level timeout / connection issues (no HTTP response at all)
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(err?.message || "")) {
    return new IntegrationError({
      category: CATEGORIES.NETWORK_TIMEOUT,
      message: "The request to eBay timed out.",
      detail: err.message,
      recoverySuggestion: "Check network connectivity to eBay's API and try again.",
      retryable: true,
      statusCode: 504,
      cause: err,
    });
  }
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ECONNRESET") {
    return new IntegrationError({
      category: CATEGORIES.NETWORK_TIMEOUT,
      message: "Could not reach eBay's servers.",
      detail: err.message,
      recoverySuggestion: "Check network/DNS connectivity and try again.",
      retryable: true,
      statusCode: 502,
      cause: err,
    });
  }

  // Rate limiting
  if (status === 429) {
    return new IntegrationError({
      category: CATEGORIES.RATE_LIMITED,
      message: "eBay rate-limited this request.",
      detail: err.message,
      recoverySuggestion: "Wait a moment and try again.",
      retryable: true,
      statusCode: 429,
      cause: err,
    });
  }

  // Auth-related — inspect the eBay error body/message to disambiguate
  if (status === 400 || status === 401 || status === 403) {
    if (/redirect_uri|runame/i.test(ebayErrorText) || /redirect_uri|runame/i.test(err?.message || "")) {
      return new IntegrationError({
        category: CATEGORIES.REDIRECT_URI_MISMATCH,
        message: "eBay rejected the redirect URI / RuName for this request.",
        detail: err.message,
        recoverySuggestion: "Confirm the RuName's 'Auth accepted URL' in the eBay Developer Portal matches this server's callback URL exactly.",
        retryable: false,
        statusCode: 400,
        cause: err,
      });
    }
    if (/invalid_client|client authentication|client_id/i.test(ebayErrorText)) {
      return new IntegrationError({
        category: CATEGORIES.INVALID_CREDENTIALS,
        message: "eBay rejected the Client ID or Client Secret.",
        detail: err.message,
        recoverySuggestion: "Verify EBAY_CLIENT_ID and EBAY_CLIENT_SECRET match the eBay Developer Portal for this environment (sandbox vs. production).",
        retryable: false,
        statusCode: 401,
        cause: err,
      });
    }
    if (/scope/i.test(ebayErrorText)) {
      return new IntegrationError({
        category: CATEGORIES.MISSING_SCOPES,
        message: "eBay rejected one or more requested scopes.",
        detail: err.message,
        recoverySuggestion: "Verify EBAY_SCOPES matches the scopes enabled for this application in the eBay Developer Portal.",
        retryable: false,
        statusCode: 400,
        cause: err,
      });
    }
    if (status === 403) {
      return new IntegrationError({
        category: CATEGORIES.PERMISSION_DENIED,
        message: "eBay denied permission for this request.",
        detail: err.message,
        recoverySuggestion: "Confirm the connected seller account has granted the required permissions.",
        retryable: false,
        statusCode: 403,
        cause: err,
      });
    }
    return new IntegrationError({
      category: CATEGORIES.INVALID_CREDENTIALS,
      message: "eBay rejected this request's authorization.",
      detail: err.message,
      recoverySuggestion: "Re-check client credentials, RuName, and scopes configured for this eBay app.",
      retryable: false,
      statusCode: status,
      cause: err,
    });
  }

  if (status >= 500) {
    return new IntegrationError({
      category: CATEGORIES.NETWORK_TIMEOUT,
      message: "eBay's servers returned an error.",
      detail: err.message,
      recoverySuggestion: "This is usually transient — try again shortly.",
      retryable: true,
      statusCode: status,
      cause: err,
    });
  }

  return new IntegrationError({
    category: CATEGORIES.UNKNOWN,
    message: err?.message || "An unexpected error occurred while connecting to eBay.",
    detail: err?.stack || String(err),
    recoverySuggestion: "Check server logs for the full error trace.",
    retryable: false,
    statusCode: 500,
    cause: err,
  });
}

function missingRefreshTokenError() {
  return new IntegrationError({
    category: CATEGORIES.MISSING_REFRESH_TOKEN,
    message: "No refresh token is available for this eBay connection.",
    detail: "account.refreshToken was null/undefined when a refresh was attempted.",
    recoverySuggestion: "Reconnect eBay from Platform Connections to obtain a new refresh token.",
    retryable: false,
    statusCode: 400,
  });
}

function invalidCallbackError(detail) {
  return new IntegrationError({
    category: CATEGORIES.INVALID_CALLBACK,
    message: "The OAuth callback from eBay was missing required parameters.",
    detail,
    recoverySuggestion: "Retry connecting eBay from Platform Connections. If this persists, check that the RuName's accepted/declined URLs point at this server's callback endpoint.",
    retryable: true,
    statusCode: 400,
  });
}

module.exports = {
  IntegrationError,
  CATEGORIES,
  classifyEbayError,
  missingRefreshTokenError,
  invalidCallbackError,
};
