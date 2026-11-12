/**
 * Redis outage (tasks2/06): kill Redis under a running app, check each route's behaviour and that responses stay
 * fast, then restart Redis on the same port and check the app recovers by itself. Skipped without redis-server.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_REDIS, startRedis, uniquePrefix } from "./helpers/redis.js";
import { startServer, testEnv } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

const timed = async (fn: () => Promise<Response>) => {
  const t0 = performance.now();
  const res = await fn();
  const body = await res.text();
  return { res, body, ms: performance.now() - t0 };
};

for (const mode of ["open", "closed"] as const) {
  describe(`redis outage, REDIS_FAILURE_MODE=${mode}`, { skip: SKIP_REDIS }, () => {
    test("degrades per the mode, stays fast, and recovers when Redis comes back", async (t) => {
      t.mock.method(console, "warn", () => {});
      let redis = await startRedis();
      const port = redis.port;
      const server = await startServer(
        testEnv({ LIMITER_STORE: "redis", REDIS_URL: redis.url, REDIS_PREFIX: uniquePrefix(), REDIS_FAILURE_MODE: mode }),
      );
      const auth = { Authorization: `Bearer ${tokens.validToken("alice", Date.now())}` };
      const resource = () => timed(() => fetch(`${server.baseUrl}/api/resource`, { headers: auth }));
      const login = (password: string) =>
        timed(() =>
          fetch(`${server.baseUrl}/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "alice", password }),
          }),
        );
      try {
        // Healthy.
        assert.equal((await resource()).res.status, 200);
        assert.equal(JSON.parse((await timed(() => fetch(`${server.baseUrl}/api/health`))).body).redis, "up");

        // Outage.
        await redis.stop();
        const r = await resource();
        assert.ok(r.ms < 1_000, `resource answered in ${Math.round(r.ms)}ms`);
        if (mode === "open") {
          assert.equal(r.res.status, 200);
          assert.equal(r.res.headers.get("x-ratelimit-degraded"), "true");
        } else {
          assert.equal(r.res.status, 503);
          assert.deepEqual(JSON.parse(r.body), { error: "limiter_unavailable" });
        }

        // Login fails closed in BOTH modes, even with the right password.
        const l = await login("pass-alice");
        assert.equal(l.res.status, 503);
        assert.ok(l.ms < 1_000);

        const health = await timed(() => fetch(`${server.baseUrl}/api/health`));
        assert.equal(health.res.status, 200);
        assert.deepEqual(
          (({ status, redis, failureMode }) => ({ status, redis, failureMode }))(JSON.parse(health.body)),
          { status: "degraded", redis: "down", failureMode: mode },
        );
        assert.equal((await fetch(`${server.baseUrl}/api/defense`)).status, 503);
        assert.equal((await fetch(`${server.baseUrl}/api/stats`)).status, 503);

        // Recovery: same port, empty Redis (the default defense is re-initialised on first read).
        redis = await startRedis(port);
        let recovered = false;
        for (let i = 0; i < 50 && !recovered; i++) {
          recovered = (await resource()).res.status === 200 && (await resource()).res.headers.get("x-ratelimit-degraded") === null;
          if (!recovered) await new Promise((res) => setTimeout(res, 100));
        }
        assert.ok(recovered, "back to normal without a restart");
        assert.equal((await login("pass-alice")).res.status, 200);
      } finally {
        await server.close();
        await redis.stop();
      }
    });
  });
}
