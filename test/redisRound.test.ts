/**
 * Shared round state in Redis (tasks2/03). Skipped without redis-server.
 * Two apps sharing one Redis + prefix stand in for two nodes behind a load balancer.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEFENSE } from "../src/config/defense.js";
import { getScenario } from "../src/scenarios/rounds.js";
import { ALGORITHMS, runDay1 } from "../scripts/day1Checks.js";
import { replay } from "../scripts/replayEngine.js";
import { fakeRunnerClock } from "./helpers/clock.js";
import { SKIP_REDIS, startRedis, uniquePrefix, type TestRedis } from "./helpers/redis.js";
import { startServer, testEnv, type TestServer } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

describe("redis round state", { skip: SKIP_REDIS }, () => {
  let redis: TestRedis;
  before(async () => {
    redis = await startRedis();
  });
  after(() => redis?.stop());

  const node = (prefix: string, id: string, now?: () => number) =>
    startServer(testEnv({ LIMITER_STORE: "redis", REDIS_URL: redis.url, REDIS_PREFIX: prefix, NODE_ID: id }), now ? { now } : {});

  const json = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    return { status: res.status, body: (await res.json()) as any };
  };
  const deploy = (s: TestServer, config: object) =>
    json(`${s.baseUrl}/api/defense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });

  test("first read initialises the default defense; health reports the redis store", async () => {
    const a = await node(uniquePrefix(), "a");
    try {
      const health = await json(`${a.baseUrl}/api/health`);
      assert.equal(health.body.store, "redis");
      const d = await json(`${a.baseUrl}/api/defense`);
      assert.deepEqual(d.body.config, { ...DEFAULT_DEFENSE, limiterStore: "redis" }, "boot default: redis on a Redis-backed process");
    } finally {
      await a.close();
    }
  });

  test("a deploy on one node applies to every node, with the same epoch", async () => {
    const prefix = uniquePrefix();
    const [a, b] = await Promise.all([node(prefix, "a"), node(prefix, "b")]);
    try {
      const config = { algorithm: "sliding", maxRequests: 7, windowMs: 3000, keyBy: "user" };
      const deployed = await deploy(a, config);
      assert.equal(deployed.status, 200);
      const onB = await json(`${b.baseUrl}/api/defense`);
      assert.deepEqual(onB.body, deployed.body);
      assert.equal((await json(`${b.baseUrl}/api/health`)).body.algorithm, "sliding");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("stats are shared: any node reports the cluster total, and a deploy anywhere resets them", async () => {
    const prefix = uniquePrefix();
    const [a, b] = await Promise.all([node(prefix, "a"), node(prefix, "b")]);
    try {
      await deploy(a, { algorithm: "fixed", maxRequests: 50, windowMs: 10_000, keyBy: "ip" });
      const token = tokens.validToken("alice", Date.now());
      const hit = (s: TestServer, auth = true) =>
        fetch(`${s.baseUrl}/api/resource`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} }).then((r) => r.body?.cancel());
      for (let i = 0; i < 3; i++) await hit(a);
      for (let i = 0; i < 2; i++) await hit(b);
      await hit(b, false); // 401 missing_token
      await new Promise((r) => setTimeout(r, 50)); // stats writes are fire-and-forget

      for (const s of [a, b]) {
        const { body } = await json(`${s.baseUrl}/api/stats`);
        assert.equal(body.store, "redis");
        assert.equal(body.resource.total, 6);
        assert.equal(body.resource.s200, 5);
        assert.equal(body.resource.byReason.missing_token, 1);
        assert.deepEqual(body.topKeys[0], { key: "ip:127.0.0.1", requests: 5, allowed: 5, blocked: 0 });
      }

      await deploy(b, { algorithm: "token", maxRequests: 10, windowMs: 10_000, keyBy: "ip" });
      assert.equal((await json(`${a.baseUrl}/api/stats`)).body.resource.total, 0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  // Until tasks2/04 the limiter counters themselves are still per node, so on ONE node redis mode must behave
  // exactly like memory mode. Reuse the Day 1 checks and a scenario replay as the regression test.
  for (const algorithm of ALGORITHMS) {
    test(`single node in redis mode passes the Day 1 checks [${algorithm}]`, async () => {
      const { clock, now } = fakeRunnerClock();
      const a = await node(uniquePrefix(), "a", now);
      try {
        const results = await runDay1(algorithm, { baseUrl: a.baseUrl, clock });
        assert.deepEqual(results.filter((r) => !r.pass).map((r) => `case ${r.id}: ${r.detail}`), []);
      } finally {
        await a.close();
      }
    });
  }

  test("single node in redis mode: round 4 replay matches /api/stats", async () => {
    const { clock, now } = fakeRunnerClock();
    const a = await node(uniquePrefix(), "a", now);
    try {
      const r = await replay({ baseUrl: a.baseUrl, scenario: getScenario(4), config: DEFAULT_DEFENSE, clock, sequential: true });
      assert.deepEqual(r.statsCheck.mismatches, []);
      assert.equal(r.tally.legitBlocks, 0);
    } finally {
      await a.close();
    }
  });
});
