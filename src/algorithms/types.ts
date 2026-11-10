export type Algorithm = "fixed" | "sliding" | "token";

export const ALGORITHMS: readonly Algorithm[] = ["fixed", "sliding", "token"];

export interface LimitDecision {
  allowed: boolean;
  /** 0 when allowed. Otherwise milliseconds until the next request from this key would be allowed. */
  retryAfterMs: number;
  /** Best-effort count of requests still available right now (for headers and debugging). */
  remaining: number;
}

/**
 * Every limiter is pure in-memory state plus an injected clock: `allow` never calls Date.now(),
 * so behaviour is deterministic and testable. Denied requests never consume budget.
 */
export interface RateLimiter {
  readonly name: Algorithm;
  allow(key: string, now: number): LimitDecision;
  reset(): void;
  /** Number of keys currently tracked. Used for stats and the memory-cost talking point. */
  size(): number;
}

export interface LimiterOptions {
  maxRequests: number;
  windowMs: number;
  /** Fixed window only: windows are aligned to this instant (deploy time). Defaults to 0. */
  epochMs?: number;
}

export function assertValidOptions({ maxRequests, windowMs, epochMs }: LimiterOptions): void {
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new RangeError(`maxRequests must be a positive integer, got ${maxRequests}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`windowMs must be a positive number, got ${windowMs}`);
  }
  if (epochMs !== undefined && !Number.isFinite(epochMs)) {
    throw new RangeError(`epochMs must be a finite number, got ${epochMs}`);
  }
}
