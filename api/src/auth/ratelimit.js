// A simple in-memory rate limiter (sliding window). Good for a single API instance.

import { tooMany } from '../http/util.js';

export class RateLimiter {
  constructor() {
    this.hits = new Map(); // key -> array of timestamps (ms)
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /**
   * Records one attempt for `key` and throws 429 if there were already `max` attempts
   * in the last `windowSec` seconds.
   */
  hit(key, max, windowSec, message = 'Too many attempts. Please wait and try again.') {
    const now = Date.now();
    const since = now - windowSec * 1000;
    const list = (this.hits.get(key) || []).filter((t) => t > since);
    if (list.length >= max) {
      this.hits.set(key, list);
      const retryAfter = Math.max(1, Math.ceil((list[0] + windowSec * 1000 - now) / 1000));
      throw tooMany(message, retryAfter);
    }
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [k, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}
