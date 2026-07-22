const User = require("../models/User");

// Cached after first successful lookup so we don't hit the DB on every request.
let cachedBotUser = null;

const automationBotAuth = async (req, res, next) => {
  const botApiKey = process.env.AUTOMATION_BOT_API_KEY;
  const requestApiKey = req.headers["x-automation-bot-key"];

  if (!requestApiKey || requestApiKey !== botApiKey) {
    return res
      .status(401)
      .json({ success: false, message: "Unauthorized: Invalid Automation Bot API Key" });
  }

  try {
    console.log("======================================");
    console.log("Current DB:", User.db.name);
    console.log("ENV EMAIL:", process.env.AUTOMATION_BOT_EMAIL);
    console.log("ENV API KEY:", process.env.AUTOMATION_BOT_API_KEY);

    if (!cachedBotUser) {
      cachedBotUser = await User.findOne({ email: process.env.AUTOMATION_BOT_EMAIL });
    }

    console.log("FOUND USER:", cachedBotUser);
    console.log("======================================");

    if (!cachedBotUser) {
      console.error(
        "Automation Bot user not found — run `npm run seed:automation-bot` first."
      );
      return res.status(500).json({
        success: false,
        message: "Automation Bot user is not configured",
      });
    }

    req.user = cachedBotUser;
    next();
  } catch (error) {
    console.error("Automation Bot auth error:", error);
    res.status(500).json({ success: false, message: "Automation Bot authentication failed" });
  }
};

module.exports = { automationBotAuth };
