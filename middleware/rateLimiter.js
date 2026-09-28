const jwt = require("jsonwebtoken");

/**
 * In-Memory Sliding-Window Rate Limiter
 * Tracks requests per user (JWT userId) or per client IP within a sliding time window.
 */
class SlidingWindowRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 1000;
    this.max = options.max || parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 5;
    this.statusCode = options.statusCode || 429;
    this.message = options.message || {
      status: 429,
      error: "Too Many Requests",
      message: `Too many requests. Maximum allowed is ${this.max} requests per ${Math.round(this.windowMs / 1000) || 1} second(s). Please slow down and try again.`,
    };

    // Store holds: key -> Array of request timestamps (epoch ms)
    this.store = new Map();

    // Periodic sweep to evict inactive keys and prevent memory growth
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamps] of this.store.entries()) {
        const active = timestamps.filter((t) => now - t < this.windowMs);
        if (active.length === 0) {
          this.store.delete(key);
        } else {
          this.store.set(key, active);
        }
      }
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Resolves rate limit key: authenticated user ID or client IP
   */
  resolveKey(req) {
    // 1. Try to extract userId from JWT token in cookie or Authorization header
    const token =
      req.cookies?.token ||
      (req.headers?.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : null);

    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded && (decoded.userId || decoded.id || decoded._id)) {
          return `user:${decoded.userId || decoded.id || decoded._id}`;
        }
      } catch (e) {
        // invalid token, fall back to IP
      }
    }

    // 2. Fall back to client IP address
    const forwarded = req.headers["x-forwarded-for"];
    const ip = forwarded
      ? String(forwarded).split(",")[0].trim()
      : req.ip || req.socket?.remoteAddress || "anonymous";

    return `ip:${ip}`;
  }

  /**
   * Express middleware handler
   */
  middleware() {
    return (req, res, next) => {
      // 1. Skip preflight CORS requests
      if (req.method === "OPTIONS") {
        return next();
      }

      // 2. Skip server-to-server automation bot requests
      if (
        req.headers["x-automation-bot-key"] &&
        process.env.AUTOMATION_BOT_API_KEY &&
        req.headers["x-automation-bot-key"] === process.env.AUTOMATION_BOT_API_KEY
      ) {
        return next();
      }

      // 3. Skip static assets
      if (
        req.path.startsWith("/uploads") ||
        req.path.startsWith("/assets") ||
        req.path.startsWith("/api-docs")
      ) {
        return next();
      }

      const key = this.resolveKey(req);
      const now = Date.now();
      const existingTimestamps = this.store.get(key) || [];

      // Filter timestamps that fall within the current sliding window
      const validTimestamps = existingTimestamps.filter((t) => now - t < this.windowMs);

      const remaining = Math.max(0, this.max - validTimestamps.length);
      const oldestTimestamp = validTimestamps[0] || now;
      const resetSeconds = Math.max(1, Math.ceil((oldestTimestamp + this.windowMs - now) / 1000));

      // Set standard RFC-compatible rate limiting headers
      res.setHeader("X-RateLimit-Limit", this.max);
      res.setHeader("X-RateLimit-Remaining", remaining > 0 ? remaining - 1 : 0);
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + this.windowMs) / 1000));

      // If limit exceeded, return HTTP 429
      if (validTimestamps.length >= this.max) {
        res.setHeader("Retry-After", resetSeconds);
        return res.status(this.statusCode).json({
          ...this.message,
          retryAfter: resetSeconds,
        });
      }

      // Record this request
      validTimestamps.push(now);
      this.store.set(key, validTimestamps);

      return next();
    };
  }

  /**
   * Returns current telemetry for technical supervisor diagnostics
   */
  getStats() {
    const now = Date.now();
    let activeInWindow = 0;
    for (const [, timestamps] of this.store.entries()) {
      if (timestamps.some((t) => now - t < this.windowMs)) {
        activeInWindow++;
      }
    }

    return {
      windowMs: this.windowMs,
      maxRequests: this.max,
      totalTrackedKeys: this.store.size,
      activeKeysInWindow: activeInWindow,
      status: "enforcing",
    };
  }
}

// Default instance for application APIs
const defaultRateLimiter = new SlidingWindowRateLimiter();

module.exports = {
  SlidingWindowRateLimiter,
  rateLimiter: defaultRateLimiter.middleware(),
  getRateLimiterStats: () => defaultRateLimiter.getStats(),
};
