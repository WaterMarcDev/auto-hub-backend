/**
 * eBay Token Auto-Refresh
 *
 * eBay access tokens expire ~2 hours after issue. Nothing else in the
 * codebase refreshes them automatically — refreshToken() is only ever
 * invoked from the manual "Refresh" button (POST /:platform/refresh) or
 * during an explicit marketplace sync. Left alone, a successfully
 * connected eBay account silently reverts to showing "disconnected" in
 * the CRM once the access token expires, even though a valid
 * refreshToken is sitting in the database the whole time.
 *
 * This runs on a schedule and refreshes any active eBay integration
 * whose token is within an hour of expiring (or already expired), using
 * the existing IntegrationAccount.needsTokenRefresh virtual.
 *
 * Scoped strictly to platform "ebay" — no other adapters are touched.
 */
const cron = require("node-cron");
const IntegrationAccount = require("../models/IntegrationAccount.model");
const platformManager = require("./platformManager.service");

const startEbayTokenRefresh = () => {
  cron.schedule("*/15 * * * *", async () => {
    let accounts;
    try {
      accounts = await IntegrationAccount.find({
        platform: "ebay",
        isActive: true,
        refreshToken: { $ne: null },
      });
    } catch (err) {
      console.error("[EBAY_TOKEN_REFRESH] Failed to load eBay integrations:", err.message);
      return;
    }

    const due = accounts.filter((account) => account.needsTokenRefresh);
    if (due.length === 0) return;

    const adapter = platformManager.getAdapter("ebay");

    for (const account of due) {
      try {
        await adapter.refreshToken(account);
        console.log(`[EBAY_TOKEN_REFRESH] Refreshed token for integration ${account._id}`);
      } catch (err) {
        console.error(`[EBAY_TOKEN_REFRESH] Failed to refresh integration ${account._id}:`, err.message);
        try {
          await IntegrationAccount.findByIdAndUpdate(account._id, {
            errorCount: (account.errorCount || 0) + 1,
            lastErrorMessage: err.message,
            lastErrorAt: new Date(),
          });
        } catch (updateErr) {
          console.error(`[EBAY_TOKEN_REFRESH] Failed to record error for integration ${account._id}:`, updateErr.message);
        }
      }
    }
  });
};

module.exports = startEbayTokenRefresh;
