/**
 * Per-round limiter store (tasks2/09): POST /api/defense { limiterStore: "memory" | "redis" } chooses, per round,
 * whether limiter counters and login lockouts are shared (Redis) or per node (memory). Config, generation and stats
 * stay in Redis either way. Two apps sharing one Redis stand in for two nodes behind a load balancer.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateDefenseConfig } from "../src/config/defense.js";
import { SKIP_REDIS, startRedis, uniquePrefix, type TestRedis } from "./helpers/redis.js";
import { startServer, testEnv, type TestServer } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

const BASE = { algorithm: "fixed", maxRequests: 5, windowMs: 60_000, keyBy: "ip" } as const;

const post = (s: TestServer, body: object) =>
  fetch(`${s.baseUrl}/api/defense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (url: string) => (await (await fetch(url)).json()) as any;

describe("limiterStore validation", () => {
  test("absent → the effective default for the process", () => {
    const memoryOnly = validateDefenseConfig(BASE);
    const redisBacked = validateDefenseConfig(BASE, ["memory", "redis"]);
    assert.ok(memoryOnly.ok && memoryOnly.config.limiterStore === "memory");
    assert.ok(redisBacked.ok && redisBacked.config.limiterStore === "redis");
  });

  test("a value the process can't serve, or an unknown value → 400 details on limiterStore", () => {
    const redisOnMemory = validateDefenseConfig({ ...BASE, limiterStore: "redis" });
    assert.deepEqual(redisOnMemory, {
      ok: false,
      issues: [{ field: "limiterStore", message: "redis is not available on this server (start it with LIMITER_STORE=redis)" }],
    });
    const bogus = validateDefenseConfig({ ...BASE, limiterStore: "disk" }, ["memory", "redis"]);
    assert.deepEqual(bogus, { ok: false, issues: [{ field: "limiterStore", message: "must be one of: memory, redis" }] });
  });

  test("memory-only process over HTTP: accepts memory, rejects redis, health advertises only memory", async () => {
    const s = await startServer(testEnv());
    try {
      const ok = await post(s, { ...BASE, limiterStore: "memory" });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as any).config.limiterStore, "memory");

      const bad = await post(s, { ...BASE, limiterStore: "redis" });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as any).details[0].field, "limiterStore");

      const health = await json(`${s.baseUrl}/api/health`);
      assert.deepEqual([health.limiterStores, health.limiterStore], [["memory"], "memory"]);
    } finally {
      await s.close();
    }
  });
});

describe("per-round limiter store on a Redis-backed process", { skip: SKIP_REDIS }, () => {
  let redis: TestRedis;
  let nodes: TestServer[];
  before(async () => {
    redis = await startRedis();
    const prefix = uniquePrefix();
    const env = (id: string) => testEnv({ LIMITER_STORE: "redis", REDIS_URL: redis.url, REDIS_PREFIX: prefix, NODE_ID: id });
    nodes = await Promise.all([startServer(env("a")), startServer(env("b"))]);
  });
  after(async () => {
    await Promise.all((nodes ?? []).map((n) => n.close()));
    await redis?.stop();
  });

  /** 12 requests alternating between the two nodes, as a round-robin load balancer would send them. */
  const alternate = async () => {
    const headers = { Authorization: `Bearer ${tokens.validToken("user01", Date.now())}`, "X-Forwarded-For": "10.6.6.6" };
    let allowed = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${nodes[i % 2]!.baseUrl}/api/resource`, { headers });
      await res.body?.cancel();
      if (res.status === 200) allowed++;
    }
    return allowed;
  };

  const failedLoginsBeforeLockout = async (ip: string) => {
    let failures = 0;
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${nodes[i % 2]!.baseUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "user02", password: "wrong" }),
      });
      await res.body?.cancel();
      if (res.status === 401) failures++;
    }
    return failures;
  };

  test("health advertises both stores and the current round's choice", async () => {
    await post(nodes[0]!, BASE);
    const h = await json(`${nodes[1]!.baseUrl}/api/health`);
    assert.deepEqual([h.limiterStores, h.limiterStore], [["memory", "redis"], "redis"]);
  });

  test("no field → today's behaviour: one shared budget (5 of 12 allowed across 2 nodes)", async () => {
    const res = await post(nodes[0]!, BASE);
    assert.equal(((await res.json()) as any).config.limiterStore, "redis");
    assert.equal(await alternate(), 5);
  });

  test("switching per round on the same processes: memory → 10 (5 per node), redis → 5, memory → 10", async () => {
    for (const [store, expected] of [["memory", 10], ["redis", 5], ["memory", 10]] as const) {
      const res = await post(nodes[0]!, { ...BASE, limiterStore: store });
      const body = (await res.json()) as any;
      assert.equal(body.config.limiterStore, store);
      // One deploy, through one node, reaches the other: both report the round's choice.
      assert.equal((await json(`${nodes[1]!.baseUrl}/api/defense`)).config.limiterStore, store);
      assert.equal(await alternate(), expected, `${store} round`);
    }
  });

  test("login lockouts follow the round: memory → 10 failures (5 per node), redis → 5", async () => {
    await post(nodes[1]!, { ...BASE, limiterStore: "memory" });
    assert.equal(await failedLoginsBeforeLockout("10.6.6.21"), 10);
    await post(nodes[1]!, { ...BASE, limiterStore: "redis" });
    assert.equal(await failedLoginsBeforeLockout("10.6.6.22"), 5);
  });

  test("stats stay shared in a memory round; trackedKeys is the answering node's own count", async () => {
    await post(nodes[0]!, { ...BASE, limiterStore: "memory" });
    await alternate();
    await new Promise((r) => setTimeout(r, 50)); // stats writes are fire-and-forget
    for (const n of nodes) {
      const s = await json(`${n.baseUrl}/api/stats`);
      assert.equal(s.limiterStore, "memory");
      assert.equal(s.resource.total, 12, "cluster-wide counts from any node");
      assert.equal(s.resource.s200, 10);
      assert.deepEqual(s.topKeys[0], { key: "ip:10.6.6.6", requests: 12, allowed: 10, blocked: 2 });
      assert.equal(s.trackedKeys, 1, "this node's own in-memory key");
    }
  });
});

describe("PerRoundLoginGuard generations (review fix on #16)", () => {
  test("a stale request from an older round never resets or records into the current round", async () => {
    const { PerRoundLoginGuard, LOGIN_LIMIT } = await import("../src/auth/loginGuard.js");
    const shared = { check: async () => ({ allowed: true, retryAfterMs: 0, remaining: 5 }), recordFailure: async () => {} };
    const guard = new PerRoundLoginGuard(shared);
    const ip = "10.6.6.6";

    // Round 7 (memory): lock the IP out.
    for (let i = 0; i < LOGIN_LIMIT.maxFailures; i++) await guard.recordFailure(ip, 1_000, 7, "memory");
    assert.equal((await guard.check(ip, 1_000, 7, "memory")).allowed, false);

    // A late request still carrying round 6 must not reset round 7's lockout, and its failure doesn't count.
    assert.equal((await guard.check(ip, 1_000, 6, "memory")).allowed, false);
    await guard.recordFailure("10.0.0.9", 1_000, 6, "memory");
    for (let i = 0; i < LOGIN_LIMIT.maxFailures - 1; i++) await guard.recordFailure("10.0.0.9", 1_000, 7, "memory");
    assert.equal((await guard.check("10.0.0.9", 1_000, 7, "memory")).allowed, true, "the stale failure wasn't counted");
    assert.equal((await guard.check(ip, 1_000, 7, "memory")).allowed, false, "round 7's lockout survived");

    // A newer round clears it.
    assert.equal((await guard.check(ip, 1_000, 8, "memory")).allowed, true);
  });
});
