/**
 * Platform OAuth business logic. Extracted 1:1 from
 * controllers/platformOAuth.controller.js during the clean-architecture
 * migration — every diagnostic log call, error-classification branch, and
 * IntegrationAccount persistence rule is preserved exactly.
 *
 * SECURITY-CRITICAL FILE: this is a live OAuth connect/callback/disconnect/
 * refresh/status flow (eBay, Amazon, Google Ads, TikTok, WhatsApp). Nothing
 * about token exchange, token storage, or error classification behavior is
 * changed — only WHERE the code lives changes. Each function returns a
 * plain, clearly-typed result descriptor; the controller (unchanged
 * request/response shape) maps that descriptor to the exact same
 * res.json()/res.redirect()/res.send() call the original inline code made.
 */
const mongoose = require("mongoose");
const integrationAccountRepository = require("../repositories/integrationAccount.repository");
const platformManager = require("../services/platformManager.service");
const { logAction } = require("../services/auditLog.service");
const { classifyEbayError, invalidCallbackError } = require("../services/integrationErrors");
const { unsupportedPlatformResponse, generateEbayTraceId, logEbayTrace, logEbayError } = require("../controllers/integrationShared.util");

/**
 * GET /api/integrations/:platform/connect
 */
async function connectPlatform({ platform, userId, protocol, host }) {
  const isEbay = platform === "ebay";
  const traceId = isEbay ? generateEbayTraceId() : null;

  if (!platformManager.hasAdapter(platform)) {
    return { kind: "unsupported", body: unsupportedPlatformResponse(platform), traceId, isEbay };
  }

  const userIdForState = userId?.toString() || "";
  const stateValue = isEbay ? `${userIdForState}::${traceId}` : userIdForState;

  const authUrl = await platformManager.connect(platform, {
    redirectUri: `${protocol}://${host}/api/integrations/${platform}/callback`,
    state: stateValue,
    ...(isEbay ? { traceId } : {}),
  });

  return {
    kind: "success",
    body: { success: true, data: { authUrl, ...(isEbay ? { traceId } : {}) } },
    traceId,
    isEbay,
  };
}

function logConnectDiagnostics({ isEbay, traceId, userId, requestUrl, hasSession, ip }) {
  if (!isEbay) return;
  logEbayTrace(traceId, "CONNECT_REQUEST_RECEIVED", {
    function: "connectPlatform",
    userId: userId?.toString() || null,
    requestUrl,
    hasSession,
    ip,
  });
}

function handleConnectError(err, { isEbay, traceId, platform }) {
  if (isEbay) {
    const classified = classifyEbayError(err);
    logEbayError(traceId, "CONNECT_REQUEST_FAILED", "connectPlatform", classified);
    console.error(`[INTEGRATION] ${platform} connect error:`, classified);
    return { kind: "ebay_error", statusCode: classified.statusCode, body: { ...classified.toJSON(), traceId } };
  }

  console.error(`[INTEGRATION] ${platform} connect error:`, err);
  const statusCode = err.statusCode || 500;
  return {
    kind: "generic_error",
    statusCode,
    body: { success: false, code: err.code || "INTERNAL_ERROR", message: err.message },
  };
}

/**
 * GET /api/integrations/:platform/callback
 *
 * Catches its own errors (rather than letting the controller's try/catch
 * handle them) specifically so ebayTraceId — which is either extracted from
 * `state` or, when absent, minted via generateEbayTraceId() — is computed
 * exactly ONCE per request and reused consistently between the success and
 * error paths. Recomputing it separately in the controller's catch block
 * would risk generating a second, different random trace ID for the
 * ambiguous case, breaking the "one traceId per request" diagnostic
 * guarantee the original inline code preserved implicitly (traceId was a
 * single local variable in scope for the whole function, try/catch included).
 */
async function handleCallback(params) {
  const { platform } = params;
  const isEbay = platform === "ebay";
  const ebayTraceId = isEbay
    ? (typeof params.state === "string" && params.state.includes("::") ? params.state.split("::")[1] : generateEbayTraceId())
    : null;

  try {
    return await handleCallbackInner(params, isEbay, ebayTraceId);
  } catch (err) {
    return handleCallbackError(err, { isEbay, ebayTraceId, platform });
  }
}

async function handleCallbackInner({ code, state, error, errorDescription, protocol, host, query, platform }, isEbay, ebayTraceId) {
  if (isEbay) {
    logEbayTrace(ebayTraceId, "CALLBACK_ENTERED", {
      function: "handleCallback",
      fullCallbackUrl: `${protocol}://${host}/api/integrations/${platform}/callback`,
      queryParams: query,
      codePresent: Boolean(code),
      statePresent: Boolean(state),
      errorPresent: Boolean(error),
      errorDescription: errorDescription || null,
    });
  }

  if (error) {
    if (isEbay) {
      logEbayError(ebayTraceId, "CALLBACK_OAUTH_ERROR_PARAM", "handleCallback", new Error(`${error}: ${errorDescription || "Authorization was denied"}`));
    }

    await logAction({
      action: "oauth_failed",
      status: "failure",
      platform,
      message: `OAuth callback error: ${error}`,
      metadata: { error, errorDescription },
    });

    return {
      kind: "oauth_error_html",
      html: `
        <html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h2 style="color: #e53e3e;">OAuth Failed</h2>
          <p>${error}: ${errorDescription || "Authorization was denied"}</p>
          <p><a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/integrations">Back to Integrations</a></p>
        </body></html>
      `,
    };
  }

  if (!code) {
    if (isEbay) {
      const classified = invalidCallbackError("OAuth callback arrived without a 'code' query parameter.");
      logEbayError(ebayTraceId, "CALLBACK_MISSING_CODE", "handleCallback", classified);
      return { kind: "ebay_error", statusCode: classified.statusCode, body: { ...classified.toJSON(), traceId: ebayTraceId } };
    }
    return { kind: "missing_code", statusCode: 400, body: { success: false, message: "Authorization code is required" } };
  }

  if (!platformManager.hasAdapter(platform)) {
    return { kind: "unsupported", body: unsupportedPlatformResponse(platform) };
  }

  // Exchange authorization code for tokens
  const tokenResult = await platformManager.getAdapter(platform).exchangeAuthorizationCode(code, {
    redirectUri: `${protocol}://${host}/api/integrations/${platform}/callback`,
    ...(isEbay ? { traceId: ebayTraceId } : {}),
  });

  if (isEbay) {
    const existingCount = await integrationAccountRepository.countDocuments({ platform });
    logEbayTrace(ebayTraceId, "BEFORE_MONGO_SAVE", {
      function: "handleCallback",
      platform,
      existingRecordCount: existingCount,
      willCreateNew: existingCount === 0,
    });
  }

  // Find or create the integration account
  let integration = await integrationAccountRepository.findOne({ platform }).sort({ createdAt: -1 });

  if (integration) {
    integration.accessToken = tokenResult.accessToken;
    integration.scope = tokenResult.scope ? tokenResult.scope.split(" ") : [];
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
    integration = await integrationAccountRepository.create({
      platform,
      accessToken: tokenResult.accessToken,
      scope: tokenResult.scope ? tokenResult.scope.split(" ") : [],
      refreshToken: tokenResult.refreshToken || null,
      tokenExpiresAt: tokenResult.expiresIn ? new Date(Date.now() + tokenResult.expiresIn * 1000) : null,
      isActive: true,
      isConnected: true,
      lastSyncAt: new Date(),
    });
  }

  await integrationAccountRepository.save(integration);

  if (isEbay) {
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
    platformManager
      .getAdapter(platform)
      .sync(integration, {})
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

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const redirectUrl = `${frontendUrl}/integrations?connected=${platform}`;

  if (isEbay) {
    logEbayTrace(ebayTraceId, "BEFORE_REDIRECT", { function: "handleCallback", frontendUrl, redirectUrl });
  }

  return { kind: "redirect", url: redirectUrl, isEbay, ebayTraceId };
}

async function handleCallbackError(err, { isEbay, ebayTraceId, platform }) {
  if (isEbay) {
    const classified = classifyEbayError(err);
    logEbayError(ebayTraceId, "CALLBACK_FAILED", "handleCallback", classified);
    console.error(`[INTEGRATION] ${platform} callback error:`, classified);

    await logAction({
      action: "oauth_failed",
      status: "failure",
      platform,
      message: `OAuth callback failed: ${classified.message}`,
      errorMessage: classified.message,
      metadata: { category: classified.category },
    });

    return {
      kind: "oauth_error_html",
      html: `
        <html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h2 style="color: #e53e3e;">Connection Failed</h2>
          <p>${classified.message}</p>
          ${classified.recoverySuggestion ? `<p style="color: #6b7280; font-size: 14px;">${classified.recoverySuggestion}</p>` : ""}
          <p><a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/integrations">Back to Integrations</a></p>
        </body></html>
      `,
    };
  }

  console.error(`[INTEGRATION] ${platform} callback error:`, err);

  await logAction({
    action: "oauth_failed",
    status: "failure",
    platform,
    message: `OAuth callback failed: ${err.message}`,
    errorMessage: err.message,
  });

  return {
    kind: "oauth_error_html",
    html: `
      <html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h2 style="color: #e53e3e;">Connection Failed</h2>
        <p>${err.message}</p>
        <p><a href="${process.env.FRONTEND_URL || "http://localhost:5173"}/integrations">Back to Integrations</a></p>
      </body></html>
    `,
  };
}

/**
 * POST /api/integrations/:platform/disconnect
 */
async function disconnectPlatform(platform) {
  if (!platformManager.hasAdapter(platform)) {
    return { kind: "unsupported", body: unsupportedPlatformResponse(platform) };
  }

  const integration = await integrationAccountRepository.findOne({ platform, isActive: true }).sort({ createdAt: -1 });

  if (!integration) {
    return { kind: "not_found", statusCode: 404, body: { success: false, message: `No active ${platform} integration found` } };
  }

  await platformManager.disconnect(platform, integration);

  return { kind: "success", body: { success: true, message: `${platform} disconnected successfully` } };
}

function handleDisconnectError(err, { platform }) {
  const isEbay = platform === "ebay";
  if (isEbay) {
    const classified = classifyEbayError(err);
    console.error(`[INTEGRATION] ${platform} disconnect error:`, classified);
    return { statusCode: classified.statusCode, body: classified.toJSON() };
  }
  console.error(`[INTEGRATION] ${platform} disconnect error:`, err);
  return { statusCode: 500, body: { success: false, message: err.message } };
}

/**
 * POST /api/integrations/:platform/refresh
 */
async function refreshPlatformToken(platform) {
  if (!platformManager.hasAdapter(platform)) {
    return { kind: "unsupported", body: unsupportedPlatformResponse(platform) };
  }

  const integration = await integrationAccountRepository.findOne({ platform, isActive: true }).sort({ createdAt: -1 });

  if (!integration) {
    return { kind: "not_found", statusCode: 404, body: { success: false, message: `No active ${platform} integration found` } };
  }

  const updated = await platformManager.refreshToken(platform, integration);

  return {
    kind: "success",
    body: { success: true, message: `${platform} token refreshed successfully`, data: updated.toJSON() },
  };
}

function handleRefreshError(err, { platform }) {
  const isEbay = platform === "ebay";
  if (isEbay) {
    const classified = classifyEbayError(err);
    console.error(`[INTEGRATION] ${platform} refresh error:`, classified);
    return { statusCode: classified.statusCode, body: classified.toJSON() };
  }
  console.error(`[INTEGRATION] ${platform} refresh error:`, err);
  return { statusCode: 500, body: { success: false, message: err.message } };
}

/**
 * GET /api/integrations/:platform/status
 */
async function platformStatus(platform) {
  const isEbay = platform === "ebay";
  const traceId = isEbay ? generateEbayTraceId() : null;

  if (!platformManager.hasAdapter(platform)) {
    return { kind: "unsupported", body: unsupportedPlatformResponse(platform), traceId, isEbay };
  }

  const integration = await integrationAccountRepository.findOne({ platform, isActive: true }).sort({ createdAt: -1 });

  if (!integration) {
    if (isEbay) {
      logEbayTrace(traceId, "STATUS_NO_INTEGRATION_FOUND", {
        function: "platformStatus",
        mongoConnected: mongoose.connection.readyState === 1,
      });
    }
    return {
      kind: "success",
      body: {
        success: true,
        data: { platform, connected: false, status: "disconnected", message: `No ${platform} integration found` },
      },
      traceId,
      isEbay,
    };
  }

  if (isEbay) {
    logEbayTrace(traceId, "BEFORE_HEALTH_CHECK", {
      function: "platformStatus",
      mongoConnected: mongoose.connection.readyState === 1,
      tokenExists: Boolean(integration.accessToken),
      refreshTokenExists: Boolean(integration.refreshToken),
      tokenExpiresAt: integration.tokenExpiresAt,
      currentTime: new Date().toISOString(),
    });
  }

  const health = await platformManager.getAdapter(platform).healthCheck(integration, isEbay ? traceId : undefined);

  const status = integration.isConnected && health.healthy ? "connected" : integration.isConnected && !health.healthy ? "error" : "disconnected";

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
    logEbayTrace(traceId, "STATUS_RESULT", { function: "platformStatus", healthyResult: health.healthy, returnedJson: responseData });
  }

  return { kind: "success", body: { success: true, data: responseData }, traceId, isEbay };
}

function handleStatusError(err, { platform, traceId }) {
  const isEbay = platform === "ebay";
  if (isEbay) {
    const classified = classifyEbayError(err);
    logEbayError(traceId, "STATUS_CHECK_FAILED", "platformStatus", classified);
    console.error(`[INTEGRATION] ${platform} status error:`, classified);
    return { statusCode: classified.statusCode, body: classified.toJSON() };
  }
  console.error(`[INTEGRATION] ${platform} status error:`, err);
  return { statusCode: 500, body: { success: false, message: err.message } };
}

async function resolveActiveIntegration(platform) {
  const integration = await integrationAccountRepository.findOne({ platform, isActive: true }).sort({ createdAt: -1 });
  if (!integration) {
    const err = new Error(`${platform} is not connected`);
    err.statusCode = 404;
    throw err;
  }
  return integration;
}

/**
 * GET /api/integrations/:platform/orders
 */
async function fetchOrders(platform) {
  const integration = await resolveActiveIntegration(platform);
  const orders = await platformManager.getAdapter(platform).fetchOrders(integration);
  return { count: orders.length, data: orders };
}

/**
 * GET /api/integrations/:platform/listings
 */
async function fetchListings(platform) {
  const integration = await resolveActiveIntegration(platform);
  const listings = await platformManager.getAdapter(platform).fetchListings(integration);
  return { count: listings.length, data: listings };
}

/**
 * GET /api/integrations/:platform/messages
 */
async function fetchMessages(platform) {
  const integration = await resolveActiveIntegration(platform);
  const messages = await platformManager.getAdapter(platform).fetchMessages(integration);
  return { count: messages.length, data: messages };
}

/**
 * POST /api/integrations/:platform/sync
 */
async function syncPlatform(platform) {
  const integration = await resolveActiveIntegration(platform);
  const result = await platformManager.getAdapter(platform).sync(integration);
  return { data: result };
}

module.exports = {
  connectPlatform,
  logConnectDiagnostics,
  handleConnectError,
  handleCallback,
  handleCallbackError,
  disconnectPlatform,
  handleDisconnectError,
  refreshPlatformToken,
  handleRefreshError,
  platformStatus,
  handleStatusError,
  fetchOrders,
  fetchListings,
  fetchMessages,
  syncPlatform,
};
