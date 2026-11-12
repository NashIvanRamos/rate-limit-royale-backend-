/**
 * Login lockout in Redis (tasks2/05). Skipped without redis-server.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { LOGIN_LIMIT, LoginGuard, RedisLoginGuard } from "../src/auth/loginGuard.js";
import { createRedis, type AppRedis } from "../src/redis/client.js";
import { SKIP_REDIS, startRedis, uniquePrefix, type TestRedis } from "./helpers/redis.js";
import { startServer, testEnv, type TestServer } from "./helpers/server.js";

describe("redis login guard", { skip: SKIP_REDIS }, () => {
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

  test("same decisions as the in-memory guard; check never records", async () => {
    const memory = new LoginGuard();
    const shared = new RedisLoginGuard(redis, uniquePrefix());
    let now = 1_000_000;
    for (let i = 0; i < 12; i++) {
      // Checking repeatedly must not count as a failure.
      for (let c = 0; c < 3; c++) assert.deepEqual(await shared.check("10.6.6.6", now, 1), await memory.check("10.6.6.6", now));
      await memory.recordFailure("10.6.6.6", now);
      await shared.recordFailure("10.6.6.6", now, 1);
      now += i === 7 ? LOGIN_LIMIT.windowMs : 1_000; // one jump past the window to see the lockout lift
    }
    assert.deepEqual(await shared.check("10.6.6.6", now, 1), await memory.check("10.6.6.6", now));
  });

  test("a new generation (deploy) clears the lockout", async () => {
    const guard = new RedisLoginGuard(redis, uniquePrefix());
    for (let i = 0; i < LOGIN_LIMIT.maxFailures; i++) await guard.recordFailure("10.6.6.6", 1, 1);
    assert.equal((await guard.check("10.6.6.6", 1, 1)).allowed, false);
    assert.equal((await guard.check("10.6.6.6", 1, 2)).allowed, true);
  });

  test("two nodes share one failure budget, and a deploy on either clears it", async () => {
    const prefix = uniquePrefix();
    const env = (id: string) => testEnv({ LIMITER_STORE: "redis", REDIS_URL: server.url, REDIS_PREFIX: prefix, NODE_ID: id });
    const nodes: TestServer[] = await Promise.all([startServer(env("a")), startServer(env("b"))]);
    const attempt = async (n: TestServer, password = "wrong") => {
      const res = await fetch(`${n.baseUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.6.6.6" },
        body: JSON.stringify({ username: "user01", password }),
      });
      await res.body?.cancel();
      return res.status;
    };
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push(await attempt(nodes[i % 2]!));
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
      assert.equal(await attempt(nodes[0]!, "pass-user01"), 429, "locked out even with the right password");

      const deploy = await fetch(`${nodes[1]!.baseUrl}/api/defense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" }),
      });
      assert.equal(deploy.status, 200);
      assert.equal(await attempt(nodes[0]!, "pass-user01"), 200);
    } finally {
      await Promise.all(nodes.map((n) => n.close()));
    }
  });
});
