/**
 * Platform OAuth Controller
 *
 * Manages the OAuth connect/callback/disconnect/refresh/status flow for
 * external platform integrations (eBay, Amazon, Google Ads, TikTok, and any
 * future adapter). Split out of the original integration.controller.js so
 * this OAuth-only surface can evolve independently of the webhook-receiving
 * surface (see platformWebhook.controller.js), which is shared with live
 * WhatsApp messaging and must not be affected by OAuth-flow changes.
 *
 *   GET  /api/integrations/:platform/connect
 *   GET  /api/integrations/:platform/callback
 *   POST /api/integrations/:platform/disconnect
 *   POST /api/integrations/:platform/refresh
 *   GET  /api/integrations/:platform/status
 *
 * Adding a new platform = create adapter + register. No controller changes.
 */
const platformOAuthService = require("../services/platformOAuth.service");

/**
 * GET /api/integrations/:platform/connect
 * Initiate OAuth for a specific platform.
 * Returns a redirect URL to the platform's OAuth page.
 */
exports.connectPlatform = async (req, res) => {
  const { platform } = req.params;

  try {
    const result = await platformOAuthService.connectPlatform({
      platform,
      userId: req.user?._id,
      protocol: req.protocol,
      host: req.get("host"),
    });

    if (result.isEbay) {
      platformOAuthService.logConnectDiagnostics({
        isEbay: true,
        traceId: result.traceId,
        userId: req.user?._id,
        requestUrl: req.originalUrl,
        hasSession: Boolean(req.session),
        ip: req.ip,
      });
    }

    return res.json(result.body);
  } catch (err) {
    const isEbay = platform === "ebay";
    const errorResult = platformOAuthService.handleConnectError(err, { isEbay, platform });
    return res.status(errorResult.statusCode).json(errorResult.body);
  }
};

/**
 * GET /api/integrations/:platform/callback
 * Handle OAuth callback from a platform.
 * Exchanges the authorization code for tokens and stores them.
 */
exports.handleCallback = async (req, res) => {
  const { platform } = req.params;
  const { code, state, error } = req.query;

  const result = await platformOAuthService.handleCallback({
    platform,
    code,
    state,
    error,
    errorDescription: req.query.error_description,
    protocol: req.protocol,
    host: req.get("host"),
    query: req.query,
  });

  switch (result.kind) {
    case "oauth_error_html":
      return res.send(result.html);
    case "ebay_error":
      return res.status(result.statusCode).json(result.body);
    case "missing_code":
      return res.status(result.statusCode).json(result.body);
    case "unsupported":
      return res.json(result.body);
    case "redirect":
      try {
        res.redirect(result.url);
        if (result.isEbay) {
          const { logEbayTrace } = require("./integrationShared.util");
          logEbayTrace(result.ebayTraceId, "AFTER_REDIRECT", {
            function: "handleCallback",
            redirectCompleted: true,
            statusCode: res.statusCode,
            locationHeader: res.getHeader("Location"),
          });
        }
        return;
      } catch (redirectErr) {
        if (result.isEbay) {
          const { logEbayTrace, logEbayError } = require("./integrationShared.util");
          logEbayTrace(result.ebayTraceId, "REDIRECT_FAILED", {
            function: "handleCallback",
            currentUrl: req.originalUrl,
            targetUrl: result.url,
            headersSent: res.headersSent,
          });
          logEbayError(result.ebayTraceId, "REDIRECT_FAILED", "handleCallback", redirectErr);
        }
        const errorResult = await platformOAuthService.handleCallbackError(redirectErr, {
          isEbay: result.isEbay,
          ebayTraceId: result.ebayTraceId,
          platform,
        });
        return res.send(errorResult.html);
      }
    default:
      // Should never happen — defensive fallback matching the original's
      // generic catch-block behavior.
      return res.status(500).send("Unexpected OAuth callback result");
  }
};

/**
 * POST /api/integrations/:platform/disconnect
 * Disconnect and revoke access for a specific platform.
 */
exports.disconnectPlatform = async (req, res) => {
  const { platform } = req.params;

  try {
    const result = await platformOAuthService.disconnectPlatform(platform);
    if (result.kind === "not_found") {
      return res.status(result.statusCode).json(result.body);
    }
    return res.json(result.body);
  } catch (err) {
    const errorResult = platformOAuthService.handleDisconnectError(err, { platform });
    return res.status(errorResult.statusCode).json(errorResult.body);
  }
};

/**
 * POST /api/integrations/:platform/refresh
 * Refresh the access token for a specific platform.
 */
exports.refreshPlatformToken = async (req, res) => {
  const { platform } = req.params;

  try {
    const result = await platformOAuthService.refreshPlatformToken(platform);
    if (result.kind === "not_found") {
      return res.status(result.statusCode).json(result.body);
    }
    return res.json(result.body);
  } catch (err) {
    const errorResult = platformOAuthService.handleRefreshError(err, { platform });
    return res.status(errorResult.statusCode).json(errorResult.body);
  }
};

/**
 * GET /api/integrations/:platform/status
 * Get the connection status for a specific platform.
 */
exports.platformStatus = async (req, res) => {
  const { platform } = req.params;

  try {
    const result = await platformOAuthService.platformStatus(platform);
    return res.json(result.body);
  } catch (err) {
    const errorResult = platformOAuthService.handleStatusError(err, { platform });
    return res.status(errorResult.statusCode).json(errorResult.body);
  }
};

/**
 * GET /api/integrations/:platform/orders
 * Fetch eBay Orders
 */
exports.fetchOrders = async (req, res) => {
  try {
    const { platform } = req.params;
    const result = await platformOAuthService.fetchOrders(platform);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/integrations/:platform/listings
 * Fetch eBay Listings
 */
exports.fetchListings = async (req, res) => {
  try {
    const { platform } = req.params;
    const result = await platformOAuthService.fetchListings(platform);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/integrations/:platform/messages
 * Fetch eBay Messages
 */
exports.fetchMessages = async (req, res) => {
  try {
    const { platform } = req.params;
    const result = await platformOAuthService.fetchMessages(platform);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:platform/sync
 * Run complete eBay Sync
 */
exports.syncPlatform = async (req, res) => {
  try {
    const { platform } = req.params;
    const result = await platformOAuthService.syncPlatform(platform);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};
