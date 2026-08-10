// Shared source whitelist for customer requests (Part Request + Junk Car
// Request) created via the Automation Bot. Kept in one place so the two
// controllers' whitelists can't drift apart — previously Junk Car's own
// local copy of this list was missing "eBay" and "Google Business", so bot
// requests from those platforms were silently downgraded to "Other".
const BOT_SOURCES = [
    "Website",
    "Instagram",
    "Facebook",
    "WhatsApp",
    "TikTok",
    "eBay",
    "Google Business",
    "SMS",
    "Other",
];

module.exports = { BOT_SOURCES };
