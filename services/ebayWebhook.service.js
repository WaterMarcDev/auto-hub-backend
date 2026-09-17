/**
 * eBay account-deletion webhook business logic. Extracted 1:1 from
 * controllers/ebay.controller.js during the clean-architecture migration.
 * No Mongoose model is touched by this controller, so no repository layer
 * exists for it — this is pure crypto/verification logic.
 */
const crypto = require("crypto");

/**
 * Computes eBay's expected challengeResponse hash for the Marketplace
 * Account Deletion webhook verification handshake.
 *
 * SECURITY: EBAY_VERIFICATION_TOKEN is a secret shared only with eBay
 * (proves this endpoint's ownership) — it and the hash derived from it
 * must never be logged.
 */
function computeChallengeResponse(challengeCode) {
  const endpoint = process.env.EBAY_ENDPOINT;
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;

  console.log(
    "[EBAY_CHALLENGE] Received challenge_code, endpoint configured:",
    Boolean(endpoint),
    "verification token configured:",
    Boolean(verificationToken)
  );

  return crypto
    .createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");
}

module.exports = {
  computeChallengeResponse,
};
