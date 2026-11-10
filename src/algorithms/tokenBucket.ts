/**
 * Token bucket.
 *
 * Trade-off: allows a controlled initial burst (up to `capacity`), then enforces a steady average
 * rate as tokens refill. Memory is O(1) per key (two numbers). It's friendly to real clients that
 * are bursty but well-behaved, and less strict than a sliding log over any single window.
 *
 * capacity     = maxRequests
 * refillPerMs  = maxRequests / windowMs   (same long-run average as the other two limiters)
 * Refill is lazy: computed from elapsed time on each call, so there are no timers.
 */
import { assertValidOptions, type LimitDecision, type LimiterOptions, type RateLimiter } from "./types.js";

interface Bucket {
  tokens: number;
  last: number;
}

/** Tolerance for floating-point drift so a request at exactly `now + retryAfterMs` succeeds. */
const EPSILON = 1e-9;

export class TokenBucketLimiter implements RateLimiter {
  readonly name = "token" as const;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: LimiterOptions) {
    assertValidOptions(options);
    this.capacity = options.maxRequests;
    this.refillPerMs = options.maxRequests / options.windowMs;
  }

  allow(key: string, now: number): LimitDecision {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    } else {
      // Guard against a clock moving backwards: treat it as no time elapsed.
      const elapsed = Math.max(0, now - bucket.last);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.last = Math.max(bucket.last, now);
    }

    if (bucket.tokens >= 1 - EPSILON) {
      bucket.tokens = Math.max(0, bucket.tokens - 1);
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens + EPSILON) };
    }

    const retryAfterMs = Math.ceil((1 - bucket.tokens) / this.refillPerMs);
    return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs), remaining: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }
}
