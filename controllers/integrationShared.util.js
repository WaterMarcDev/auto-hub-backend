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

module.exports = {
  unsupportedPlatformResponse,
  generateEbayTraceId,
  logEbayTrace,
  logEbayError,
};
