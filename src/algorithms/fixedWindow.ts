/**
 * Fixed window counter.
 *
 * Trade-off: one integer per key, O(1) time and memory, which makes it the cheapest option.
 * Weakness: windows reset on hard boundaries, so a client can send `maxRequests` just before a
 * boundary and another `maxRequests` just after, which is up to 2× the limit in a short burst.
 *
 * Windows are aligned to `epochMs` (deploy time) so the boundary is predictable:
 *   index = floor((now - epochMs) / windowMs)
 */
import { assertValidOptions, type LimitDecision, type LimiterOptions, type RateLimiter } from "./types.js";

interface WindowState {
  index: number;
  count: number;
}

export class FixedWindowLimiter implements RateLimiter {
  readonly name = "fixed" as const;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly epochMs: number;
  private readonly windows = new Map<string, WindowState>();

  constructor(options: LimiterOptions) {
    assertValidOptions(options);
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.epochMs = options.epochMs ?? 0;
  }

  allow(key: string, now: number): LimitDecision {
    const index = Math.floor((now - this.epochMs) / this.windowMs);
    let state = this.windows.get(key);
    if (!state || state.index !== index) {
      state = { index, count: 0 };
      this.windows.set(key, state);
    }

    if (state.count >= this.maxRequests) {
      const windowEnd = this.epochMs + (index + 1) * this.windowMs;
      return { allowed: false, retryAfterMs: windowEnd - now, remaining: 0 };
    }

    state.count += 1;
    return { allowed: true, retryAfterMs: 0, remaining: this.maxRequests - state.count };
  }

  reset(): void {
    this.windows.clear();
  }

  size(): number {
    return this.windows.size;
  }
}
