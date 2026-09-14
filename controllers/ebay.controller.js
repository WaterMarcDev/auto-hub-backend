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