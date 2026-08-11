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

// Case/whitespace-tolerant match against BOT_SOURCES — the Automation Bot is
// an external integration we don't control, so a valid platform sent as
// "instagram" or " WhatsApp " must still resolve to the canonical value
// instead of silently collapsing to "Other". Does not invent aliases: a
// value that isn't a known platform (under any casing) still becomes the
// fallback, exactly as before.
function normalizeRequestSource(rawSource, fallback = "Other") {
    if (typeof rawSource !== "string") return fallback;

    const trimmed = rawSource.trim();
    if (!trimmed) return fallback;

    const match = BOT_SOURCES.find(
        (canonical) => canonical.toLowerCase() === trimmed.toLowerCase()
    );

    return match || fallback;
}

module.exports = { BOT_SOURCES, normalizeRequestSource };
