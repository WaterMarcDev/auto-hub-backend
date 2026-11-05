const crypto = require("crypto");

exports.challenge = async (req, res) => {
  try {
    const challengeCode = req.query.challenge_code;

    if (!challengeCode) {
      return res.status(400).json({
        success: false,
        message: "Missing challenge_code",
      });
    }

    // const endpoint = `${req.protocol}://${req.get("host")}${req.baseUrl}${req.path}`;

    const endpoint = process.env.EBAY_ENDPOINT;

    const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;

    // SECURITY: EBAY_VERIFICATION_TOKEN is a secret shared only with eBay
    // (proves this endpoint's ownership for the Marketplace Account
    // Deletion webhook) — it and the hash derived from it must never be
    // logged. This previously logged both in plaintext to console, which
    // is persisted to logs/access.log & logs/error.log on this server.
    console.log("[EBAY_CHALLENGE] Received challenge_code, endpoint configured:", Boolean(endpoint), "verification token configured:", Boolean(verificationToken));

    const hash = crypto
      .createHash("sha256")
      .update(challengeCode)
      .update(verificationToken)
      .update(endpoint)
      .digest("hex");

    return res.status(200).json({
      challengeResponse: hash,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.accountDeletion = async (req, res) => {
  try {
    console.log("eBay Account Deletion Notification");

    console.log(req.body);

    /**
     * TODO:
     * 1. Verify Notification Signature
     * 2. Find Seller
     * 3. Delete/Anonymize Stored Data
     */

    return res.status(200).json({
      success: true,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
    });
  }
};
// ─── eBay Notification API (order webhooks) ─────────────────────────────────
// See services/ebayNotification.service.js. Public routes (eBay calls them);
// security comes from eBay's signature, not a login.
const ebayNotification = require("../services/ebayNotification.service");

// GET /api/integrations/ebay/notifications?challenge_code=… — destination check
exports.notificationChallenge = (req, res) => {
  const code = req.query.challenge_code;
  if (!code) return res.status(400).json({ success: false, message: "Missing challenge_code" });
  const hash = ebayNotification.challengeResponse(String(code));
  if (!hash) {
    console.error("[EBAY NOTIFICATION] challenge received but EBAY_NOTIFICATION_ENDPOINT_URL / EBAY_NOTIFICATION_VERIFICATION_TOKEN are not set");
    return res.status(500).json({ success: false, message: "Notification endpoint not configured" });
  }
  return res.status(200).json({ challengeResponse: hash });
};

// POST /api/integrations/ebay/notifications — verify, store, acknowledge
exports.notification = async (req, res) => {
  const out = await ebayNotification.receive({
    signature: req.get("x-ebay-signature"),
    rawBody: req.rawBody,
    body: req.body,
  });
  if (out.status === 204) return res.status(204).end();
  return res.status(out.status).json({ success: false, message: out.error });
};
