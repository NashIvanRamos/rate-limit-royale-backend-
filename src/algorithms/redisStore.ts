/**
 * Limiter state in Redis (tasks2/04): one LimiterStore per algorithm, each decision a single atomic Lua script, so
 * every node behind the load balancer draws from the same budget. Same semantics as the in-memory classes
 * (checked by a differential test), including "denied requests never consume budget".
 *
 * Keys, per generation (a deploy bumps it, so old keys are never read again and simply expire):
 *   fixed    <prefix>rl:<gen>:<key>:w<windowIndex>   counter
 *   sliding  <prefix>rl:<gen>:<key>                  sorted set of accepted timestamps
 *   token    <prefix>rl:<gen>:<key>                  hash { tokens, last }
 *   all      <prefix>rl:<gen>:keys                   set of keys seen this round (for /api/stats)
 *
 * Time comes from the app (`now`), not Redis TIME, so the fake-clock test suites run unchanged against Redis. With
 * several machines, clock skew between nodes would matter; production would call TIME inside the scripts.
 */
import { keyspace, type AppRedis } from "../redis/client.js";
import { assertValidOptions, type Algorithm, type LimitDecision, type LimiterOptions, type LimiterStore } from "./types.js";

const decision = (reply: unknown): LimitDecision => {
  const [allowed, retryAfterMs, remaining] = reply as [number, number, number];
  return { allowed: allowed === 1, retryAfterMs, remaining };
};

export class RedisLimiterStore implements LimiterStore {
  private readonly key: ReturnType<typeof keyspace>;
  private readonly epochMs: number;
  private readonly keysetTtlMs: number;

  constructor(
    private readonly redis: AppRedis,
    prefix: string,
    readonly name: Algorithm,
    private readonly options: LimiterOptions,
    generation: number,
  ) {
    assertValidOptions(options);
    this.key = keyspace(`${prefix}rl:${generation}:`);
    this.epochMs = options.epochMs ?? 0;
    this.keysetTtlMs = Math.max(2 * options.windowMs, 60_000);
  }

  async allow(key: string, now: number): Promise<LimitDecision> {
    const { maxRequests, windowMs } = this.options;
    const keyset = this.key("keys");
    switch (this.name) {
      case "fixed": {
        const index = Math.floor((now - this.epochMs) / windowMs);
        const windowEnd = this.epochMs + (index + 1) * windowMs;
        return decision(await this.redis.rlrFixed(this.key(key, `w${index}`), keyset, maxRequests, windowEnd, now, this.keysetTtlMs, key));
      }
      case "sliding":
        return decision(
          await this.redis.rlrSliding(this.key(key), keyset, this.key("seq"), maxRequests, windowMs, now, this.keysetTtlMs, key, "0"),
        );
      case "token": {
        const refillPerMs = maxRequests / windowMs;
        return decision(
          await this.redis.rlrToken(this.key(key), keyset, maxRequests, String(refillPerMs), now, this.keysetTtlMs, key, windowMs + 60_000),
        );
      }
    }
  }

  /** Keys seen this round. Unlike the in-memory sliding log, keys aren't dropped the moment their log empties. */
  size(): Promise<number> {
    return this.redis.scard(this.key("keys"));
  }
}
