/**
 * Sliding window log.
 *
 * Trade-off: exact. In any span of `windowMs` a key never gets more than `maxRequests`, so there's
 * no boundary burst. The cost is memory: it stores one timestamp per accepted request per key
 * (O(maxRequests) per key), which adds up with many clients or high limits.
 *
 * Denied requests are NOT logged. Logging them would let an attacker keep extending their own lockout
 * and would make memory grow with attack volume instead of with the limit.
 */
import { assertValidOptions, type LimitDecision, type LimiterOptions, type RateLimiter } from "./types.js";

export class SlidingWindowLogLimiter implements RateLimiter {
  readonly name = "sliding" as const;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  /** Accepted request timestamps per key, ascending. */
  private readonly logs = new Map<string, number[]>();

  constructor(options: LimiterOptions) {
    assertValidOptions(options);
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
  }

  allow(key: string, now: number): LimitDecision {
    const decision = this.evaluate(key, now);
    if (decision.allowed) {
      const log = this.logs.get(key);
      if (log) log.push(now);
      else this.logs.set(key, [now]);
      decision.remaining -= 1;
    }
    return decision;
  }

  /** Same decision as `allow` but never records anything. Used by the login failure limiter. */
  peek(key: string, now: number): LimitDecision {
    return this.evaluate(key, now);
  }

  reset(): void {
    this.logs.clear();
  }

  size(): number {
    return this.logs.size;
  }

  /** Prunes expired timestamps and returns the decision without recording the request. */
  private evaluate(key: string, now: number): LimitDecision {
    const log = this.logs.get(key);
    if (!log) return { allowed: true, retryAfterMs: 0, remaining: this.maxRequests };

    // A timestamp t is inside the window iff t > now - windowMs.
    const cutoff = now - this.windowMs;
    let expired = 0;
    while (expired < log.length && log[expired]! <= cutoff) expired++;
    if (expired > 0) log.splice(0, expired);

    if (log.length === 0) {
      this.logs.delete(key);
      return { allowed: true, retryAfterMs: 0, remaining: this.maxRequests };
    }

    if (log.length >= this.maxRequests) {
      // The oldest entry leaves the window at log[0] + windowMs, which frees one slot.
      return { allowed: false, retryAfterMs: log[0]! + this.windowMs - now, remaining: 0 };
    }

    return { allowed: true, retryAfterMs: 0, remaining: this.maxRequests - log.length };
  }
}
