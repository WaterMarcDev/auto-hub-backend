/**
 * Shared helpers for the generic platform-integration controllers
 * (platformOAuth.controller.js and platformWebhook.controller.js).
 *
 * Split out of the original integration.controller.js so both controllers
 * can use the same "coming soon" response and eBay diagnostic tracing
 * without duplicating them.
 */
const crypto = require("crypto");

/**
 * Return "coming_soon" instead of HTTP 400 for adapters that are not yet
 * implemented (e.g. facebook/instagram). Frontend displays "Coming Soon"
 * instead of crashing.
 */
function unsupportedPlatformResponse(platform) {
  console.log(`[PlatformManager] Adapter not registered. Platform: ${platform}. Returning coming_soon.`);
  return {
    success: true,
    data: {
      platform,
      supported: false,
      status: "coming_soon",
      message: "Platform adapter is not registered.",
    },
  };
}

// ─── eBay OAuth Diagnostic Tracing (observability only) ────────────────────
// Scoped strictly to platform === "ebay" everywhere it's used so that
// WhatsApp/Facebook/Instagram/Amazon/TikTok requests through these same
// generic, platform-agnostic handlers produce zero new log output and are
// otherwise completely unaffected.

function generateEbayTraceId() {
  return crypto.randomBytes(4).toString("hex");
}

function logEbayTrace(traceId, step, data = {}) {
  console.log(JSON.stringify({
    tag: "[EBAY][TRACE]",
    traceId: traceId || "no-trace-id",
    timestamp: new Date().toISOString(),
    platform: "ebay",
    step,
    ...data,
  }));
}

function logEbayError(traceId, step, functionName, err) {
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
    category: err?.category || null,
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

// ─── OAuth state signing (CSRF protection) ─────────────────────────────────
// The callback route is public, so without a signed state anyone could send
// the consent URL to their own marketplace account and have the callback
// overwrite the company's integration. The signed state is
// "<value>::<issuedAt>::<hmac>". The value stays at the front so the eBay
// trace ID remains at state.split("::")[1].
const OAUTH_STATE_TTL_MS = 60 * 60 * 1000;

function oauthStateHmac(payload) {
  const secret = process.env.JWT_SECRET || "fallback_secret";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function signOAuthState(value) {
  const payload = `${value}::${Date.now()}`;
  return `${payload}::${oauthStateHmac(payload)}`;
}

/** Returns true when `state` was issued by signOAuthState and hasn't expired. */
function verifyOAuthState(state) {
  if (typeof state !== "string") return false;
  const sigIndex = state.lastIndexOf("::");
  if (sigIndex === -1) return false;
  const payload = state.slice(0, sigIndex);
  const expected = Buffer.from(oauthStateHmac(payload));
  const actual = Buffer.from(state.slice(sigIndex + 2));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return false;
  }
  const issuedAt = Number(payload.slice(payload.lastIndexOf("::") + 2));
  return Number.isFinite(issuedAt) && Date.now() - issuedAt <= OAUTH_STATE_TTL_MS;
}

/** Escapes text for interpolation into the callback's inline HTML pages. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

module.exports = {
  unsupportedPlatformResponse,
  signOAuthState,
  verifyOAuthState,
  escapeHtml,
  generateEbayTraceId,
  logEbayTrace,
  logEbayError,
};
