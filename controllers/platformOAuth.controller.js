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
const mongoose = require("mongoose");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("../services/platformManager.service");
const ebayAdapter = require("../services/adapters/ebayAdapter");
const { logAction } = require("../services/auditLog.service");
const { classifyEbayError, invalidCallbackError } = require("../services/integrationErrors");
const {
  unsupportedPlatformResponse,
  generateEbayTraceId,
  logEbayTrace,
  logEbayError,
} = require("./integrationShared.util");

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
      const classified = classifyEbayError(err);
      logEbayError(traceId, "CONNECT_REQUEST_FAILED", "connectPlatform", classified);
      console.error(`[INTEGRATION] ${req.params.platform} connect error:`, classified);
      return res.status(classified.statusCode).json({ ...classified.toJSON(), traceId });
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
      if (isEbay) {
        const classified = invalidCallbackError("OAuth callback arrived without a 'code' query parameter.");
        logEbayError(ebayTraceId, "CALLBACK_MISSING_CODE", "handleCallback", classified);
        return res.status(classified.statusCode).json({ ...classified.toJSON(), traceId: ebayTraceId });
      }
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

      integration.scope = tokenResult.scope
        ? tokenResult.scope.split(" ")
        : [];
      
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

        scope: tokenResult.scope
          ? tokenResult.scope.split(" ")
          : [],
        
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

    // Auto-sync marketplace data (orders/listings/messages) right after
    // connecting, for any adapter that implements sync() (currently eBay).
    // Fire-and-forget: not awaited, so it never delays the redirect back to
    // the CRM. The .catch ensures a sync failure is only logged, never an
    // unhandled rejection, and never blocks or breaks the connect flow.
    if (typeof platformManager.getAdapter(platform).sync === "function") {
      if (isEbay) {
        logEbayTrace(ebayTraceId, "BEFORE_AUTO_SYNC", { function: "handleCallback" });
      }
      platformManager.getAdapter(platform).sync(integration, {})
        .then(() => {
          if (isEbay) {
            logEbayTrace(ebayTraceId, "AFTER_AUTO_SYNC", { function: "handleCallback" });
          }
        })
        .catch((syncErr) => {
          if (isEbay) {
            logEbayError(ebayTraceId, "AUTO_SYNC_FAILED", "handleCallback", syncErr);
          }
          console.warn(`[INTEGRATION] ${platform} auto-sync warning:`, syncErr.message);
        });
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
      const classified = classifyEbayError(err);
      logEbayError(ebayTraceId, "CALLBACK_FAILED", "handleCallback", classified);
      console.error(`[INTEGRATION] ${req.params.platform} callback error:`, classified);

      await logAction({
        action: "oauth_failed",
        status: "failure",
        platform: req.params.platform,
        message: `OAuth callback failed: ${classified.message}`,
        errorMessage: classified.message,
        metadata: { category: classified.category },
      });

      return res.send(`
        <html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h2 style="color: #e53e3e;">Connection Failed</h2>
          <p>${classified.message}</p>
          ${classified.recoverySuggestion ? `<p style="color: #6b7280; font-size: 14px;">${classified.recoverySuggestion}</p>` : ""}
          <p><a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/integrations">Back to Integrations</a></p>
        </body></html>
      `);
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
 * POST /api/integrations/:platform/disconnect
 * Disconnect and revoke access for a specific platform.
 */
exports.disconnectPlatform = async (req, res) => {
  const { platform } = req.params;
  const isEbay = platform === "ebay";

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
      return res.status(404).json({ success: false, message: `No active ${platform} integration found` });
    }

    // Disconnect via the adapter (revokes token, updates DB)
    await platformManager.disconnect(platform, integration);

    res.json({ success: true, message: `${platform} disconnected successfully` });
  } catch (err) {
    if (isEbay) {
      const classified = classifyEbayError(err);
      console.error(`[INTEGRATION] ${req.params.platform} disconnect error:`, classified);
      return res.status(classified.statusCode).json(classified.toJSON());
    }
    console.error(`[INTEGRATION] ${req.params.platform} disconnect error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/integrations/:platform/refresh
 * Refresh the access token for a specific platform.
 */
exports.refreshPlatformToken = async (req, res) => {
  const { platform } = req.params;
  const isEbay = platform === "ebay";

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
    if (isEbay) {
      const classified = classifyEbayError(err);
      console.error(`[INTEGRATION] ${req.params.platform} refresh error:`, classified);
      return res.status(classified.statusCode).json(classified.toJSON());
    }
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
      const classified = classifyEbayError(err);
      logEbayError(traceId, "STATUS_CHECK_FAILED", "platformStatus", classified);
      console.error(`[INTEGRATION] ${req.params.platform} status error:`, classified);
      return res.status(classified.statusCode).json(classified.toJSON());
    }
    console.error(`[INTEGRATION] ${req.params.platform} status error:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/integrations/:platform/orders
 * Fetch eBay Orders
 */
exports.fetchOrders = async (req, res) => {
  try {
    const { platform } = req.params;

    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      return res.status(404).json({
        success: false,
        message: `${platform} is not connected`,
      });
    }

    const orders = await platformManager
      .getAdapter(platform)
      .fetchOrders(integration);

    res.json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * GET /api/integrations/:platform/listings
 * Fetch eBay Listings
 */
exports.fetchListings = async (req, res) => {
  try {
    const {platform } = req.params;

    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      return res.status(404).json({
        success: false,
        message: `${platform} is not connected`,
      });
    }

    const listings = await platformManager
      .getAdapter(platform)
      .fetchListings(integration);

    res.json({
      success: true,
      count: listings.length,
      data: listings,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * GET /api/integrations/:platform/messages
 * Fetch eBay Messages
 */
exports.fetchMessages = async (req, res) => {
  try {
    const { platform } = req.params;

    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      return res.status(404).json({
        success: false,
        message: `${platform} is not connected`,
      });
    }

    const messages = await platformManager
      .getAdapter(platform)
      .fetchMessages(integration);

    res.json({
      success: true,
      count: messages.length,
      data: messages,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


/**
 * POST /api/integrations/:platform/sync
 * Run complete eBay Sync
 */
exports.syncPlatform = async (req, res) => {
  try {
    const { platform } = req.params;

    const integration = await IntegrationAccount.findOne({
      platform,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (!integration) {
      return res.status(404).json({
        success: false,
        message: `${platform} is not connected`,
      });
    }

    const result = await platformManager
      .getAdapter(platform)
      .sync(integration);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};