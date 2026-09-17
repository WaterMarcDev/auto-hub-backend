const ebayWebhookService = require("../services/ebayWebhook.service");

exports.challenge = async (req, res) => {
  try {
    const challengeCode = req.query.challenge_code;

    if (!challengeCode) {
      return res.status(400).json({
        success: false,
        message: "Missing challenge_code",
      });
    }

    const hash = ebayWebhookService.computeChallengeResponse(challengeCode);

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
