/**
 * Redis limiters (tasks2/04). Skipped without redis-server.
 *
 * 1. Differential: the same random request sequence through the in-memory limiter and the Redis store must give
 *    identical decisions, request by request. That's the strongest "same semantics" check.
 * 2. Atomicity: 50 concurrent requests at max 10 → exactly 10 allowed. A naive GET-then-INCR version lets far more through.
 * 3. End to end: two nodes sharing Redis enforce ONE budget.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ALGORITHMS, createLimiter, type LimitDecision } from "../src/algorithms/index.js";
import { RedisLimiterStore } from "../src/algorithms/redisStore.js";
import { createRedis, type AppRedis } from "../src/redis/client.js";
import { SKIP_REDIS, startRedis, uniquePrefix, type TestRedis } from "./helpers/redis.js";
import { startServer, testEnv, type TestServer } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("redis limiters", { skip: SKIP_REDIS }, () => {
  let server: TestRedis;
  let redis: AppRedis;
  before(async () => {
    server = await startRedis();
    redis = createRedis(server.url);
  });
  after(async () => {
    await redis?.quit();
    await server?.stop();
  });

  for (const algorithm of ALGORITHMS) {
    test(`[${algorithm}] differential: identical decisions to the in-memory limiter over 600 random requests`, async () => {
      const options = { maxRequests: 5, windowMs: 1_000, epochMs: 1_000_000 };
      const memory = createLimiter(algorithm, options);
      const store = new RedisLimiterStore(redis, uniquePrefix(), algorithm, options, 1);
      const rand = rng(42 + algorithm.length);
      let now = options.epochMs;
      let denied = 0;
      for (let i = 0; i < 600; i++) {
        // Mostly bursts (0–30ms apart), sometimes long gaps, across 3 keys.
        now += rand() < 0.85 ? Math.floor(rand() * 30) : Math.floor(rand() * 2_500);
        const key = `ip:10.0.0.${Math.floor(rand() * 3)}`;
        const expected: LimitDecision = memory.allow(key, now);
        const actual = await store.allow(key, now);
        assert.deepEqual(actual, expected, `request ${i}: ${key} at +${now - options.epochMs}ms`);
        if (!expected.allowed) denied++;
      }
      // Guard against a vacuous pass: the sequence must exercise denials and retryAfterMs, not just allows.
      assert.ok(denied >= 50 && denied <= 550, `denied ${denied} of 600`);
      assert.equal(await store.size(), 3);
    });

    test(`[${algorithm}] atomic: 50 concurrent requests at max 10 → exactly 10 allowed`, async () => {
      const store = new RedisLimiterStore(redis, uniquePrefix(), algorithm, { maxRequests: 10, windowMs: 60_000, epochMs: 0 }, 1);
      const results = await Promise.all(Array.from({ length: 50 }, () => store.allow("ip:10.6.6.6", 5_000)));
      assert.equal(results.filter((r) => r.allowed).length, 10);
    });
  }

  test("why Lua: a naive GET-then-INCR limiter lets concurrent requests through over the limit", async () => {
    const key = `${uniquePrefix()}naive`;
    const naiveAllow = async () => {
      const count = Number((await redis.get(key)) ?? 0); // read…
      if (count >= 10) return false; // …decide…
      await redis.incr(key); // …write. Another client can run between these steps.
      return true;
    };
    const results = await Promise.all(Array.from({ length: 50 }, naiveAllow));
    const allowed = results.filter(Boolean).length;
    console.log(`  naive limiter allowed ${allowed} of 50 (limit 10)`);
    assert.ok(allowed > 10, `naive allowed ${allowed}; expected the race to let more than 10 through`);
  });

  test("keys are namespaced by generation: a new generation starts from a full budget", async () => {
    const prefix = uniquePrefix();
    const options = { maxRequests: 2, windowMs: 60_000, epochMs: 0 };
    const gen1 = new RedisLimiterStore(redis, prefix, "sliding", options, 1);
    await gen1.allow("k", 1);
    await gen1.allow("k", 1);
    assert.equal((await gen1.allow("k", 1)).allowed, false);
    const gen2 = new RedisLimiterStore(redis, prefix, "sliding", options, 2);
    assert.equal((await gen2.allow("k", 1)).allowed, true);
    assert.equal(await gen2.size(), 1);
  });

  describe("end to end: two nodes, one budget", () => {
    for (const algorithm of ALGORITHMS) {
      test(`[${algorithm}] alternating between nodes still allows exactly maxRequests`, async () => {
        const prefix = uniquePrefix();
        let t = 1_800_000_000_000;
        const now = () => t;
        const env = (id: string) => testEnv({ LIMITER_STORE: "redis", REDIS_URL: server.url, REDIS_PREFIX: prefix, NODE_ID: id });
        const nodes: TestServer[] = await Promise.all([startServer(env("a"), { now }), startServer(env("b"), { now })]);
        try {
          const deploy = await fetch(`${nodes[0]!.baseUrl}/api/defense`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ algorithm, maxRequests: 5, windowMs: 10_000, keyBy: "ip" }),
          });
          assert.equal(deploy.status, 200);
          const auth = { Authorization: `Bearer ${tokens.validToken("user01", t)}`, "X-Forwarded-For": "10.6.6.6" };
          const statuses: number[] = [];
          for (let i = 0; i < 12; i++) {
            const res = await fetch(`${nodes[i % 2]!.baseUrl}/api/resource`, { headers: auth });
            await res.body?.cancel();
            statuses.push(res.status);
          }
          assert.deepEqual(statuses, [...Array(5).fill(200), ...Array(7).fill(429)]);
          const stats = (await (await fetch(`${nodes[1]!.baseUrl}/api/stats`)).json()) as { trackedKeys: number };
          assert.equal(stats.trackedKeys, 1, "one key cluster-wide");
        } finally {
          await Promise.all(nodes.map((n) => n.close()));
        }
      });
    }
  });
});
