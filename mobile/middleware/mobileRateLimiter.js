const config = require("../config/mobileConfig");

/**
 * Sliding Window In-Memory Rate Limiter for Mobile App Endpoints
 */
function createMobileRateLimiter(options = {}) {
  const windowMs = options.windowMs || config.rateLimit.authWindowMs;
  const maxRequests = options.maxRequests || config.rateLimit.maxAuthAttempts;
  const hits = new Map();

  // Periodic cleanup of stale IP windows every 5 minutes
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) hits.delete(key);
      else hits.set(key, valid);
    }
  }, 5 * 60 * 1000);

  if (cleanupTimer.unref) cleanupTimer.unref();

  return function (req, res, next) {
    const clientIp =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "unknown-ip";

    const key = req.appUser ? `user:${req.appUser.id}` : `ip:${clientIp}`;
    const now = Date.now();

    const timestamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    hits.set(key, timestamps);

    const remaining = Math.max(0, maxRequests - timestamps.length);
    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);

    if (timestamps.length > maxRequests) {
      const oldestHit = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldestHit + windowMs - now) / 1000));
      res.setHeader("Retry-After", retryAfterSec);
      return res.status(429).json({
        success: false,
        error: "Too many requests. Please slow down and try again.",
        retryAfterSeconds: retryAfterSec,
      });
    }

    next();
  };
}

const mobileAuthLimiter = createMobileRateLimiter({
  windowMs: config.rateLimit.authWindowMs,
  maxRequests: config.rateLimit.maxAuthAttempts,
});

const mobileApiLimiter = createMobileRateLimiter({
  windowMs: config.rateLimit.apiWindowMs,
  maxRequests: config.rateLimit.maxApiRequests,
});

module.exports = {
  mobileAuthLimiter,
  mobileApiLimiter,
  createMobileRateLimiter,
};
