const config = require("../config/mobileConfig");

class MobileCacheService {
  constructor() {
    this.store = new Map();
    this.maxEntries = config.cache.maxEntries || 1000;
    this.defaultTtl = config.cache.ttlMs || 300000;
  }

  _makeKey(userId) {
    const rawId = String(userId).replace(/^usr_/, "");
    return `app:user:${rawId}`;
  }

  get(userId) {
    if (!userId) return null;
    const key = this._makeKey(userId);
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(userId, value, ttlMs = this.defaultTtl) {
    if (!userId || !value) return;
    const key = this._makeKey(userId);

    // Evict oldest entry if at capacity (FIFO/LRU)
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiry: Date.now() + ttlMs,
    });
  }

  del(userId) {
    if (!userId) return;
    const key = this._makeKey(userId);
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  getStats() {
    let activeEntries = 0;
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now <= entry.expiry) activeEntries++;
      else this.store.delete(key);
    }
    return {
      activeEntries,
      maxEntries: this.maxEntries,
      defaultTtlMs: this.defaultTtl,
    };
  }
}

module.exports = new MobileCacheService();
