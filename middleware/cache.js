const cacheService = require("../services/cache.service");

/**
 * Route-level caching middleware
 * 
 * @param {string} prefix - Namespace prefix (e.g. "master:make", "dash:summary")
 * @param {number} ttlSeconds - Time-To-Live in seconds
 */
const cacheMiddleware = (prefix, ttlSeconds = 300) => {
  return (req, res, next) => {
    // Only cache safe GET requests
    if (req.method !== "GET") {
      return next();
    }

    const key = `${prefix}:${req.originalUrl}`;
    const cachedData = cacheService.get(key);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cachedData);
    }

    res.setHeader("X-Cache", "MISS");

    // Intercept res.json to capture response payload
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only cache successful 200 responses
      if (res.statusCode === 200 && body) {
        cacheService.set(key, body, ttlSeconds);
      }
      return originalJson(body);
    };

    next();
  };
};

module.exports = {
  cacheMiddleware,
  cacheService,
};
