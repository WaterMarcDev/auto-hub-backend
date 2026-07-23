/**
 * Integration Controller
 *
 * Manages OAuth connections to external platforms.
 *
 * Handles:
 *   - Connect/disconnect platform accounts
 *   - OAuth callback handling
 *   - Token management (refresh, revoke)
 *   - Connection status
 *   - Webhook management
 *   - Generic parameterized endpoints for any platform:
 *     GET  /api/integrations/:platform/connect
 *     GET  /api/integrations/:platform/callback
 *     GET  /api/integrations/:platform/webhook
 *     POST /api/integrations/:platform/webhook
 *     POST /api/integrations/:platform/disconnect
 *     POST /api/integrations/:platform/refresh
 *     GET  /api/integrations/:platform/status
 *
 * Adding a new platform = create adapter + register. No controller changes.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");

// ─── eBay OAuth Diagnostic Tracing (observability only) ────────────────────
// Scoped strictly to platform === "ebay" everywhere it's used below so that
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

/**
 * GET /api/integrations
 * Get all connected integrations.
 */
exports.getAll = async (req, res) => {
  try {
    const { platform, isActive } = req.query;
    const query = {};

    if (platform) query.platform = platform;
    if (isActive !== undefined) query.isActive = isActive === "true";

    const integrations = await IntegrationAccount.find(query)
      .select("-accessToken -refreshToken -webhookSecret")
      .sort({ platform: 1, createdAt: -1 })
      .lean();

    res.json({ success: true, data: integrations });
  } catch (err) {
    console.error("[INTEGRATION] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/integrations/:id
 * Get a single integration by ID.
 */
exports.getById = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id)
      .select("-accessToken -refreshToken -webhookSecret")
      .lean();

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    res.json({ success: true, data: integration });
  } catch (err) {
    console.error("[INTEGRATION] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/connect
 * Register a new platform connection with provided tokens.
 *
 * This is called after the OAuth flow completes.
 * For browser-based OAuth, the frontend redirects to the platform's
 * OAuth URL, then the callback sends tokens here.
 */
exports.connect = async (req, res) => {
  try {
    const {
      platform,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      platformUserId,
      platformPageId,
      platformEmail,
      platformName,
      metadata,
    } = req.body;

    if (!platform || !accessToken) {
      return res.status(400).json({ success: false, message: "Platform and access token are required" });
    }

    // Check if integration already exists for this platform + user
    let integration = await IntegrationAccount.findOne({
      platform,
      platformUserId: platformUserId || null,
    });

    if (integration) {
      // Update existing
      integration.accessToken = accessToken;
      if (refreshToken) integration.refreshToken = refreshToken;
      if (tokenExpiresAt) integration.tokenExpiresAt = new Date(tokenExpiresAt);
      if (platformPageId) integration.platformPageId = platformPageId;
      if (platformEmail) integration.platformEmail = platformEmail;
      if (platformName) integration.platformName = platformName;
      if (metadata) integration.metadata = { ...integration.metadata, ...metadata };
      integration.isConnected = true;
      integration.isActive = true;
      integration.lastSyncAt = new Date();
      integration.errorCount = 0;
      integration.lastErrorMessage = null;
    } else {
      // Create new
      integration = await IntegrationAccount.create({
        platform,
        accessToken,
        refreshToken,
        tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
        platformUserId,
        platformPageId,
        platformEmail,
        platformName,
        metadata: metadata || {},
        isActive: true,
        isConnected: true,
        lastSyncAt: new Date(),
      });
    }

    await integration.save();

    await logAction({
      action: "platform_connected",
      status: "success",
      platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Platform connected: ${platform}${platformEmail ? ` (${platformEmail})` : ""}`,
      userId: req.user?._id,
    });

    res.json({
      success: true,
      message: `${platform} connected successfully`,
      data: integration.toJSON(),
    });
  } catch (err) {
    console.error("[INTEGRATION] Connect error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:id/disconnect
 * Disconnect and deactivate an integration.
 */
exports.disconnect = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    integration.isActive = false;
    integration.isConnected = false;
    await integration.save();

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: integration.platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Platform disconnected: ${integration.platform}`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Integration disconnected" });
  } catch (err) {
    console.error("[INTEGRATION] Disconnect error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:id/refresh
 * Manually trigger a token refresh.
 */
exports.refreshToken = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    if (!integration.refreshToken) {
      return res.status(400).json({ success: false, message: "No refresh token available" });
    }

    const updated = await platformManager.refreshToken(integration.platform, integration);

    res.json({
      success: true,
      message: "Token refreshed successfully",
      data: updated.toJSON(),
    });
  } catch (err) {
    console.error("[INTEGRATION] Refresh error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:id/webhook/verify
 * Verify webhook endpoint for a platform.
 */
exports.verifyWebhook = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    integration.webhookVerified = true;
    integration.webhookLastPing = new Date();
    await integration.save();

    await logAction({
      action: "webhook_verified",
      status: "success",
      platform: integration.platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Webhook verified for ${integration.platform}`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Webhook verified" });
  } catch (err) {
    console.error("[INTEGRATION] Webhook verify error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/integrations/:id/webhook-config
 * Update webhook configuration.
 */
exports.updateWebhookConfig = async (req, res) => {
  try {
    const { webhookConfig } = req.body;

    const integration = await IntegrationAccount.findByIdAndUpdate(
      req.params.id,
      { webhookConfig: webhookConfig || {} },
      { new: true }
    ).select("-accessToken -refreshToken -webhookSecret");

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    res.json({ success: true, data: integration });
  } catch (err) {
    console.error("[INTEGRATION] Webhook config error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/integrations/:id
 * Remove an integration permanently.
 */
exports.remove = async (req, res) => {
  try {
    const integration = await IntegrationAccount.findByIdAndDelete(req.params.id);

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    await logAction({
      action: "platform_disconnected",
      status: "success",
      platform: integration.platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Integration removed: ${integration.platform}`,
      userId: req.user?._id,
    });

    res.json({ success: true, message: "Integration removed" });
  } catch (err) {
    console.error("[INTEGRATION] Delete error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// NEW GENERIC PLATFORM METHODS
// These methods are parameterized by :platform and work with any adapter.
// Adding a new platform = create adapter + register it. No controller changes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Helper: return "coming_soon" response for unregistered platforms.
 * Prevents HTTP 400 errors for platforms like facebook/instagram that
 * don't have adapters yet. Frontend displays "Coming Soon" instead of crashing.
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

/**
 * GET /api/integrations/:platform/connect
 * Initiate OAuth for a specific platform.
 * Returns a redirect URL to the platform's OAuth page.
 */
exports.connectPlatform = async (req, res) => {
  const { platform } = req.params;
  const isEbay = platform === "ebay";
  const traceId = isEbay ? generateEbayTraceId() : null;

  if (isEbay) {
    // ─── DIAGNOSTIC: LOG 1 — connect request received ─────────────────────
    logEbayTrace(traceId, "CONNECT_REQUEST_RECEIVED", {
      function: "connectPlatform",
      userId: req.user?._id?.toString() || null,
      requestUrl: req.originalUrl,
      hasSession: Boolean(req.session),
      ip: req.ip,
    });
  }

  try {
    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    const userIdForState = req.user?._id?.toString() || "";
    const stateValue = isEbay ? `${userIdForState}::${traceId}` : userIdForState;

    const authUrl = await platformManager.connect(platform, {
      redirectUri: `${req.protocol}://${req.get("host")}/api/integrations/${platform}/callback`,
      state: stateValue,
      ...(isEbay ? { traceId } : {}),
    });

    res.json({ success: true, data: { authUrl, ...(isEbay ? { traceId } : {}) } });
  } catch (err) {
    if (isEbay) {
      logEbayError(traceId, "CONNECT_REQUEST_FAILED", "connectPlatform", err);
    }
    console.error(`[INTEGRATION] ${req.params.platform} connect error:`, err);
    //----------------------------------------------------
    // BUGFIX
    // Propagate structured error code from metaAdapter
    // when META_APP_ID is missing.
    //----------------------------------------------------
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      code: err.code || "INTERNAL_ERROR",
      message: err.message,
      ...(isEbay ? { traceId } : {}),
    });
  }
};

/**
 * GET /api/integrations/:platform/callback
 * Handle OAuth callback from a platform.
 * Exchanges the authorization code for tokens and stores them.
 */
exports.handleCallback = async (req, res) => {
  const { platform } = req.params;
  const isEbay = platform === "ebay";
  const { code, state, error } = req.query;

  // For eBay, the traceId was embedded in `state` as "<userId>::<traceId>" by
  // connectPlatform(). Extract it if present; otherwise mint a fresh one so
  // this callback execution is still fully traceable (e.g. eBay stripped/
  // altered the state param, or the request arrived without one).
  const ebayTraceId = isEbay
    ? (typeof state === "string" && state.includes("::") ? state.split("::")[1] : generateEbayTraceId())
    : null;

  if (isEbay) {
    // ─── DIAGNOSTIC: LOG 4 — callback entered ─────────────────────────────
    logEbayTrace(ebayTraceId, "CALLBACK_ENTERED", {
      function: "handleCallback",
      fullCallbackUrl: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      queryParams: req.query,
      codePresent: Boolean(code),
      statePresent: Boolean(state),
      errorPresent: Boolean(error),
      errorDescription: req.query.error_description || null,
    });
  }

  try {
    if (error) {
      if (isEbay) {
        logEbayError(ebayTraceId, "CALLBACK_OAUTH_ERROR_PARAM", "handleCallback", new Error(`${error}: ${req.query.error_description || "Authorization was denied"}`));
      }

      await logAction({
        action: "oauth_failed",
        status: "failure",
        platform,
        message: `OAuth callback error: ${error}`,
        metadata: { error, errorDescription: req.query.error_description },
      });

      // Render a simple error page
      return res.send(`
        <html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h2 style="color: #e53e3e;">OAuth Failed</h2>
          <p>${error}: ${req.query.error_description || "Authorization was denied"}</p>
          <p><a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/integrations">Back to Integrations</a></p>
        </body></html>
      `);
    }

    if (!code) {
      return res.status(400).json({ success: false, message: "Authorization code is required" });
    }

    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    // Exchange authorization code for tokens
    const tokenResult = await platformManager.getAdapter(platform).exchangeAuthorizationCode(code, {
      redirectUri: `${req.protocol}://${req.get("host")}/api/integrations/${platform}/callback`,
      ...(isEbay ? { traceId: ebayTraceId } : {}),
    });

    if (isEbay) {
      // ─── DIAGNOSTIC: LOG 7 — before MongoDB save ──────────────────────────
      const existingCount = await IntegrationAccount.countDocuments({ platform });
      logEbayTrace(ebayTraceId, "BEFORE_MONGO_SAVE", {
        function: "handleCallback",
        platform,
        existingRecordCount: existingCount,
        willCreateNew: existingCount === 0,
      });
    }

    // Find or create the integration account
    let integration = await IntegrationAccount.findOne({ platform }).sort({ createdAt: -1 });

    if (integration) {
      integration.accessToken = tokenResult.accessToken;
      if (tokenResult.refreshToken) integration.refreshToken = tokenResult.refreshToken;
      if (tokenResult.expiresIn) {
        integration.tokenExpiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000);
      }
      integration.isActive = true;
      integration.isConnected = true;
      integration.lastSyncAt = new Date();
      integration.errorCount = 0;
      integration.lastErrorMessage = null;
    } else {
      integration = await IntegrationAccount.create({
        platform,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken || null,
        tokenExpiresAt: tokenResult.expiresIn
          ? new Date(Date.now() + tokenResult.expiresIn * 1000)
          : null,
        isActive: true,
        isConnected: true,
        lastSyncAt: new Date(),
      });
    }

    await integration.save();

    if (isEbay) {
      // ─── DIAGNOSTIC: LOG 8 — after MongoDB save ─────────────────────────
      logEbayTrace(ebayTraceId, "AFTER_MONGO_SAVE", {
        function: "handleCallback",
        documentId: integration._id,
        isConnected: integration.isConnected,
        isActive: integration.isActive,
        updatedAt: integration.updatedAt,
      });
    }

    // Fetch business account info
    try {
      await platformManager.getAdapter(platform).fetchBusinessAccount(integration, isEbay ? ebayTraceId : undefined);
    } catch (bizErr) {
      if (isEbay) {
        logEbayError(ebayTraceId, "FETCH_BUSINESS_ACCOUNT_CONTROLLER_CATCH", "handleCallback", bizErr);
      }
      console.warn(`[INTEGRATION] ${platform} fetchBusinessAccount warning:`, bizErr.message);
    }

    // Fetch phone number(s) if applicable (WhatsApp)
    try {
      if (typeof platformManager.getAdapter(platform).fetchPhoneNumber === "function") {
        await platformManager.getAdapter(platform).fetchPhoneNumber(integration);
      }
    } catch (phoneErr) {
      console.warn(`[INTEGRATION] ${platform} fetchPhoneNumber warning:`, phoneErr.message);
    }

    // Register webhook
    try {
      if (isEbay) {
        logEbayTrace(ebayTraceId, "BEFORE_REGISTER_WEBHOOK_CONTROLLER", { function: "handleCallback" });
      }
      await platformManager.getAdapter(platform).registerWebhook(integration, isEbay ? ebayTraceId : undefined);
      if (isEbay) {
        logEbayTrace(ebayTraceId, "AFTER_REGISTER_WEBHOOK_CONTROLLER", { function: "handleCallback" });
      }
    } catch (webhookErr) {
      if (isEbay) {
        logEbayError(ebayTraceId, "REGISTER_WEBHOOK_CONTROLLER_CATCH", "handleCallback", webhookErr);
      }
      console.warn(`[INTEGRATION] ${platform} registerWebhook warning:`, webhookErr.message);
    }

    await logAction({
      action: "platform_connected",
      status: "success",
      platform,
      entityType: "integration_account",
      entityId: integration._id,
      message: `Platform connected via OAuth: ${platform}`,
      metadata: { tokenType: tokenResult.tokenType },
    });

    // Redirect to frontend with success
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const redirectUrl = `${frontendUrl}/integrations?connected=${platform}`;

    if (isEbay) {
      // ─── DIAGNOSTIC: LOG 13 — before redirect ────────────────────────────
      logEbayTrace(ebayTraceId, "BEFORE_REDIRECT", {
        function: "handleCallback",
        frontendUrl,
        redirectUrl,
      });
    }

    try {
      res.redirect(redirectUrl);
      if (isEbay) {
        // ─── DIAGNOSTIC: LOG 14 — after redirect ───────────────────────────
        logEbayTrace(ebayTraceId, "AFTER_REDIRECT", {
          function: "handleCallback",
          redirectCompleted: true,
          statusCode: res.statusCode,
          locationHeader: res.getHeader("Location"),
        });
      }
    } catch (redirectErr) {
      if (isEbay) {
        // ─── DIAGNOSTIC: REDIRECT DEBUGGING ────────────────────────────────
        logEbayTrace(ebayTraceId, "REDIRECT_FAILED", {
          function: "handleCallback",
          currentUrl: req.originalUrl,
          targetUrl: redirectUrl,
          headersSent: res.headersSent,
        });
        logEbayError(ebayTraceId, "REDIRECT_FAILED", "handleCallback", redirectErr);
      }
      throw redirectErr;
    }
  } catch (err) {
    if (isEbay) {
      logEbayError(ebayTraceId, "CALLBACK_FAILED", "handleCallback", err);
    }
    console.error(`[INTEGRATION] ${req.params.platform} callback error:`, err);

    await logAction({
      action: "oauth_failed",
      status: "failure",
      platform: req.params.platform,
      message: `OAuth callback failed: ${err.message}`,
      errorMessage: err.message,
    });

    res.send(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h2 style="color: #e53e3e;">Connection Failed</h2>
        <p>${err.message}</p>
        <p><a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/integrations">Back to Integrations</a></p>
      </body></html>
    `);
  }
};

/**
 * GET /api/integrations/:platform/webhook
 * Verify a webhook endpoint (platform sends GET to verify).
 * Used by Meta (WhatsApp, Facebook, Instagram) and other platforms.
 */
exports.verifyWebhookEndpoint = async (req, res) => {
  try {
    const { platform } = req.params;

    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    const adapter = platformManager.getAdapter(platform);

    // The adapter's verifyWebhook method handles the platform-specific verification
    const result = adapter.verifyWebhook(req.query);

    if (result.verified) {
      // Update the integration's webhook verification status
      await IntegrationAccount.findOneAndUpdate(
        { platform, isActive: true },
        {
          webhookVerified: true,
          webhookLastPing: new Date(),
        }
      );

      // Return the challenge as plain text (Meta requires this)
      return res.status(200).type("text/plain").send(String(result.challenge));
    }

    // Verification failed
    await logAction({
      action: "webhook_verification_failed",
      status: "failure",
      platform,
      message: `Webhook verification failed for ${platform}`,
      metadata: { query: req.query },
    });

    res.status(403).json({ success: false, message: "Webhook verification failed" });
  } catch (err) {
    console.error(`[INTEGRATION] ${req.params.platform} webhook verify error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:platform/webhook
 * Receive incoming webhook events from a platform.
 * This is where messages, status updates, and other events arrive.
 */
exports.receiveWebhookEndpoint = async (req, res) => {
  try {
    const { platform } = req.params;

    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    // Process the webhook payload through the platform manager
    const result = await platformManager.receiveWebhook(platform, req.body);

    // Acknowledge the webhook (platforms expect a 200 OK quickly)
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[INTEGRATION] ${req.params.platform} webhook receive error:`, err);

    // Always return 200 to prevent platform from retrying failed webhooks
    // that we've already logged internally
    res.json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:platform/disconnect
 * Disconnect and revoke access for a specific platform.
 */
exports.disconnectPlatform = async (req, res) => {
  try {
    const { platform } = req.params;

    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    // Find the active integration for this platform
    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      return res.status(404).json({ success: false, message: `No active ${platform} integration found` });
    }

    // Disconnect via the adapter (revokes token, updates DB)
    await platformManager.disconnect(platform, integration);

    res.json({ success: true, message: `${platform} disconnected successfully` });
  } catch (err) {
    console.error(`[INTEGRATION] ${req.params.platform} disconnect error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:platform/refresh
 * Refresh the access token for a specific platform.
 */
exports.refreshPlatformToken = async (req, res) => {
  try {
    const { platform } = req.params;

    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    // Find the active integration for this platform
    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      return res.status(404).json({ success: false, message: `No active ${platform} integration found` });
    }

    // Refresh via the adapter
    const updated = await platformManager.refreshToken(platform, integration);

    res.json({
      success: true,
      message: `${platform} token refreshed successfully`,
      data: updated.toJSON(),
    });
  } catch (err) {
    console.error(`[INTEGRATION] ${req.params.platform} refresh error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/integrations/:platform/status
 * Get the connection status for a specific platform.
 */
exports.platformStatus = async (req, res) => {
  const { platform } = req.params;
  const isEbay = platform === "ebay";
  const traceId = isEbay ? generateEbayTraceId() : null;

  try {
    //----------------------------------------------------
    // BUGFIX
    // Return "coming_soon" instead of HTTP 400
    // for adapters that are not yet implemented.
    //----------------------------------------------------
    if (!platformManager.hasAdapter(platform)) {
      return res.json(unsupportedPlatformResponse(platform));
    }

    // Find the active integration for this platform
    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      if (isEbay) {
        logEbayTrace(traceId, "STATUS_NO_INTEGRATION_FOUND", {
          function: "platformStatus",
          mongoConnected: mongoose.connection.readyState === 1,
        });
      }
      return res.json({
        success: true,
        data: {
          platform,
          connected: false,
          status: "disconnected",
          message: `No ${platform} integration found`,
        },
      });
    }

    if (isEbay) {
      // ─── DIAGNOSTIC: HEALTH DEBUGGING — pre-check state ────────────────────
      logEbayTrace(traceId, "BEFORE_HEALTH_CHECK", {
        function: "platformStatus",
        mongoConnected: mongoose.connection.readyState === 1,
        tokenExists: Boolean(integration.accessToken),
        refreshTokenExists: Boolean(integration.refreshToken),
        tokenExpiresAt: integration.tokenExpiresAt,
        currentTime: new Date().toISOString(),
      });
    }

    // Run a health check
    const health = await platformManager.getAdapter(platform).healthCheck(integration, isEbay ? traceId : undefined);

    const status = integration.isConnected && health.healthy
      ? "connected"
      : integration.isConnected && !health.healthy
        ? "error"
        : "disconnected";

    const responseData = {
      platform,
      connected: integration.isConnected && health.healthy,
      status,
      integrationId: integration._id,
      businessAccountId: integration.platformBusinessId,
      phoneNumberId: integration.platformPageId,
      displayName: integration.platformName,
      isActive: integration.isActive,
      webhookVerified: integration.webhookVerified,
      lastSyncAt: integration.lastSyncAt,
      tokenExpiresAt: integration.tokenExpiresAt,
      health: health.details,
      metadata: integration.metadata,
    };

    if (isEbay) {
      // ─── DIAGNOSTIC: HEALTH DEBUGGING — result ──────────────────────────────
      logEbayTrace(traceId, "STATUS_RESULT", {
        function: "platformStatus",
        healthyResult: health.healthy,
        returnedJson: responseData,
      });
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (err) {
    if (isEbay) {
      logEbayError(traceId, "STATUS_CHECK_FAILED", "platformStatus", err);
    }
    console.error(`[INTEGRATION] ${req.params.platform} status error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};