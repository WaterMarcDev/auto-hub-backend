/**
 * AutoHub Mobile Application Subsystem Configuration
 */

module.exports = {
  jwt: {
    secret: process.env.APP_JWT_SECRET || process.env.JWT_SECRET || "autohub_mobile_secure_fallback_secret",
    accessExpiry: process.env.APP_JWT_ACCESS_EXPIRY || "1h", // Short-lived access token
    refreshExpiryDays: parseInt(process.env.APP_JWT_REFRESH_EXPIRY_DAYS || "30", 10), // 30 days
  },
  cache: {
    ttlMs: 5 * 60 * 1000, // 5 minutes
    maxEntries: 1000, // < 2MB RAM footprint
  },
  rateLimit: {
    authWindowMs: 15 * 60 * 1000, // 15 minutes
    maxAuthAttempts: 10, // Max 10 login/register attempts per 15 min per IP
    apiWindowMs: 60 * 1000, // 1 minute
    maxApiRequests: 60, // 60 requests per minute for authenticated endpoints
  },
  defaultSettings: {
    pushNotifications: true,
    emailNotifications: true,
    priceDropAlerts: false,
    orderUpdates: true,
    chatMessages: true,
    notificationSounds: true,
    vibration: true,
    darkMode: true,
    autoDistanceUnit: true,
    selectedLanguage: "English",
    selectedLanguageFlag: "🇺🇸",
  },
};
