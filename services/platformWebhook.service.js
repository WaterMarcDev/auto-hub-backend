/**
 * Platform webhook business logic. Extracted 1:1 from
 * controllers/platformWebhook.controller.js during the clean-architecture
 * migration. Kept separate from platformOAuth's service (if any) for the
 * same reason the original controller split existed — this is the live
 * ingestion path for inbound platform events, not the OAuth connect flow.
 */
const integrationAccountRepository = require("../repositories/integrationAccount.repository");
const platformManager = require("./platformManager.service");
const { logAction } = require("./auditLog.service");

/**
 * @returns {{supported: false} | {supported: true, verified: boolean, challenge?: any}}
 */
async function verifyWebhook(platform, query) {
  if (!platformManager.hasAdapter(platform)) {
    return { supported: false };
  }

  const adapter = platformManager.getAdapter(platform);

  // The adapter's verifyWebhook method handles the platform-specific verification
  const result = adapter.verifyWebhook(query);

  if (result.verified) {
    // Update the integration's webhook verification status
    await integrationAccountRepository.findOneAndUpdate(
      { platform, isActive: true },
      {
        webhookVerified: true,
        webhookLastPing: new Date(),
      }
    );

    return { supported: true, verified: true, challenge: result.challenge };
  }

  await logAction({
    action: "webhook_verification_failed",
    status: "failure",
    platform,
    message: `Webhook verification failed for ${platform}`,
    metadata: { query },
  });

  return { supported: true, verified: false };
}

/**
 * @returns {{supported: false} | {supported: true, data: any}}
 */
async function receiveWebhook(platform, body, { headers, rawBody } = {}) {
  if (!platformManager.hasAdapter(platform)) {
    return { supported: false };
  }

  // Process the webhook payload through the platform manager. headers/
  // rawBody are only consumed by adapters that verify a signature (e.g.
  // TikTok) — passed through generically so adding another
  // signature-verifying platform later needs no controller change.
  const data = await platformManager.receiveWebhook(platform, body, { headers, rawBody });

  return { supported: true, data };
}

module.exports = {
  verifyWebhook,
  receiveWebhook,
};
