// Lead sources for customer requests (Part Request + Junk Car Request).
//
// Only these are in use: requests come from the website form, Instagram or
// Facebook. Staff can only pick these, the Automation Bot can only set these,
// and the CRM lists/filters only show these.
//
// The models' enums still accept the old values (WhatsApp, TikTok, eBay,
// Google Business, SMS, Other) so existing records keep loading and saving;
// nothing new can be given one of them except the bot's "Other" fallback.
const ACTIVE_SOURCES = ["Website", "Instagram", "Facebook"];

// Kept under its old name for the Automation Bot routes.
const BOT_SOURCES = ACTIVE_SOURCES;

// Case/whitespace-tolerant match against ACTIVE_SOURCES — the Automation Bot
// is an external integration we don't control, so "instagram" or
// " Facebook " still resolve to the canonical value. Anything else becomes
// the fallback.
function normalizeRequestSource(rawSource, fallback = "Other") {
    if (typeof rawSource !== "string") return fallback;

    const trimmed = rawSource.trim();
    if (!trimmed) return fallback;

    const match = ACTIVE_SOURCES.find(
        (canonical) => canonical.toLowerCase() === trimmed.toLowerCase()
    );

    return match || fallback;
}

module.exports = { ACTIVE_SOURCES, BOT_SOURCES, normalizeRequestSource };
