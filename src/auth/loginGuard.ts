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
import { keyspace, type AppRedis } from "../redis/client.js";
import type { LimiterStoreKind } from "../config/defense.js";

export const LOGIN_LIMIT = Object.freeze({ maxFailures: 5, windowMs: 60_000 });

/**
 * Where the failure counts live (tasks2/05). `generation` is the round's: the Redis guard namespaces its keys by it, so
 * a deploy anywhere clears lockouts everywhere. The memory guard ignores it (its own reset hook handles deploys).
 */
export interface LoginGuardBackend {
  /** Is this IP still allowed to attempt a login? Records nothing. */
  check(ip: string, now: number, generation: number, store?: LimiterStoreKind): Promise<LimitDecision>;
  recordFailure(ip: string, now: number, generation: number, store?: LimiterStoreKind): Promise<void>;
}

export class LoginGuard implements LoginGuardBackend {
  private readonly failures: SlidingWindowLogLimiter;

  constructor(limit: { maxFailures: number; windowMs: number } = LOGIN_LIMIT) {
    this.failures = new SlidingWindowLogLimiter({ maxRequests: limit.maxFailures, windowMs: limit.windowMs });
  }

  private static key(ip: string): string {
    return `login:${ip}`;
  }

  /** Is this IP still allowed to attempt a login? Records nothing. */
  check(ip: string, now: number): Promise<LimitDecision> {
    return Promise.resolve(this.failures.peek(LoginGuard.key(ip), now));
  }

  recordFailure(ip: string, now: number): Promise<void> {
    this.failures.allow(LoginGuard.key(ip), now);
    return Promise.resolve();
  }

  reset(): void {
    this.failures.reset();
  }

  size(): number {
    return this.failures.size();
  }
}

/**
 * The same failure limiter in Redis (tasks2/05): the sliding-log Lua script, in peek mode for `check`. Without it,
 * a stuffer behind a round-robin load balancer gets the failure budget once per node (measured: 15 instead of 5).
 *
 *   <prefix>login:<gen>:login:<ip>   sorted set of failure timestamps
 */
export class RedisLoginGuard implements LoginGuardBackend {
  private readonly key: ReturnType<typeof keyspace>;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: AppRedis,
    prefix: string,
    private readonly limit: { maxFailures: number; windowMs: number } = LOGIN_LIMIT,
  ) {
    this.key = keyspace(`${prefix}login:`);
    this.ttlMs = Math.max(2 * limit.windowMs, 60_000);
  }

  private async run(ip: string, now: number, generation: number, peek: boolean): Promise<LimitDecision> {
    const [allowed, retryAfterMs, remaining] = (await this.redis.rlrSliding(
      this.key(generation, `login:${ip}`),
      this.key(generation, "keys"),
      this.key(generation, "seq"),
      this.limit.maxFailures,
      this.limit.windowMs,
      now,
      this.ttlMs,
      ip,
      peek ? "1" : "0",
    )) as [number, number, number];
    return { allowed: allowed === 1, retryAfterMs, remaining };
  }

  check(ip: string, now: number, generation: number): Promise<LimitDecision> {
    return this.run(ip, now, generation, true);
  }

  async recordFailure(ip: string, now: number, generation: number): Promise<void> {
    await this.run(ip, now, generation, false);
  }
}

/**
 * Per-round choice on a Redis-backed process (tasks2/09): lockouts in Redis (shared) for "redis" rounds, or in this
 * node's own memory for "memory" rounds. The memory guard is cleared when a NEWER generation shows up, so a deploy
 * still resets lockouts on every node.
 *
 * Generations only move forward: a login that loaded generation N before a deploy can reach the guard after a request
 * from N+1 already has. It must not reset the guard back to N (that would wipe the new round's lockouts), so a stale
 * request checks against the current round and never records into it.
 */
export class PerRoundLoginGuard implements LoginGuardBackend {
  private readonly memory = new LoginGuard();
  private memoryGeneration = 0;

  constructor(private readonly shared: LoginGuardBackend) {}

  private local(generation: number): LoginGuard {
    if (generation > this.memoryGeneration) {
      this.memory.reset();
      this.memoryGeneration = generation;
    }
    return this.memory;
  }

  check(ip: string, now: number, generation: number, store: LimiterStoreKind = "redis"): Promise<LimitDecision> {
    return store === "memory" ? this.local(generation).check(ip, now) : this.shared.check(ip, now, generation);
  }

  recordFailure(ip: string, now: number, generation: number, store: LimiterStoreKind = "redis"): Promise<void> {
    if (store !== "memory") return this.shared.recordFailure(ip, now, generation);
    const guard = this.local(generation);
    // A failure from an older round doesn't count against the current one.
    if (generation < this.memoryGeneration) return Promise.resolve();
    return guard.recordFailure(ip, now);
  }
}
