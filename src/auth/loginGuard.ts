/**
 * Login limiter: always keyed by client IP (nobody is authenticated yet) and counts FAILED attempts only.
 *
 * Why failures only: credential stuffing (round 4) produces a stream of failures from one IP and gets
 * locked out fast. Account rotation (round 5) logs in 50 *valid* accounts from one IP, and those must
 * succeed so the boss wave can test the keyBy toggle on /api/resource.
 *
 * Independent of the player's configured defense. Cleared on every POST /api/defense.
 */
import { SlidingWindowLogLimiter, type LimitDecision } from "../algorithms/index.js";

export const LOGIN_LIMIT = Object.freeze({ maxFailures: 5, windowMs: 60_000 });

export class LoginGuard {
  private readonly failures: SlidingWindowLogLimiter;

  constructor(limit: { maxFailures: number; windowMs: number } = LOGIN_LIMIT) {
    this.failures = new SlidingWindowLogLimiter({ maxRequests: limit.maxFailures, windowMs: limit.windowMs });
  }

  private static key(ip: string): string {
    return `login:${ip}`;
  }

  /** Is this IP still allowed to attempt a login? Records nothing. */
  check(ip: string, now: number): LimitDecision {
    return this.failures.peek(LoginGuard.key(ip), now);
  }

  recordFailure(ip: string, now: number): void {
    this.failures.allow(LoginGuard.key(ip), now);
  }

  reset(): void {
    this.failures.reset();
  }

  size(): number {
    return this.failures.size();
  }
}
