/**
 * AutoHub In-Memory Cache Service
 * 
 * Provides high-speed in-memory caching with TTL (Time To Live),
 * atomic read/write, prefix-based multi-key invalidation, and telemetry.
 */

class MemoryCacheService {
  constructor(defaultTtlSeconds = 3600, maxEntries = 2000) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;
    this.maxEntries = maxEntries;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;

    // Periodic sweep every 60 seconds to evict expired items
    this.cleanupTimer = setInterval(() => {
      this.purgeExpired();
    }, 60000);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Retrieves a cached value if present and not expired
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  /**
   * Sets a value in the cache with optional TTL in seconds
   */
  set(key, value, ttlSeconds = null) {
    // Evict oldest entry if size exceeds maximum safe bound
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    const ttlMs = ttlSeconds !== null ? ttlSeconds * 1000 : this.defaultTtlMs;
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;

    this.store.set(key, {
      value,
      expiresAt,
      createdAt: Date.now(),
    });
    return value;
  }

  /**
   * Deletes a specific key
   */
  del(key) {
    return this.store.delete(key);
  }

  /**
   * Purges all keys starting with a prefix (e.g. "master:make", "dash:")
   */
  delPrefix(prefix) {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Completely flushes the cache
   */
  flush() {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Sweeps expired entries
   */
  purgeExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Returns cache operational telemetry for the Analytics dashboard
   */
  getStats() {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? ((this.hits / totalRequests) * 100).toFixed(1) : 0;

    return {
      totalKeys: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRatePercent: parseFloat(hitRate),
      status: "active",
    };
  }
}

// Global shared cache instance
const cacheService = new MemoryCacheService();

module.exports = cacheService;
