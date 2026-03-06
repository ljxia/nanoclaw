/**
 * In-memory sliding window rate limiter.
 * Tracks timestamps of recent invocations per key.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private maxHits: number,
    private windowMs: number,
  ) {}

  /** Returns true if the key is within limits, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.hits.get(key);

    if (timestamps) {
      timestamps = timestamps.filter((t) => t > cutoff);
    } else {
      timestamps = [];
    }

    if (timestamps.length >= this.maxHits) {
      this.hits.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
