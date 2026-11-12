import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ALGORITHMS } from "../src/algorithms/index.js";
import type { DefenseConfig, KeyBy } from "../src/config/defense.js";
import { demoPassword } from "../src/config/users.js";
import { fakeClock, startServer, testEnv, type TestServer } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

const MAX = 5;
const WINDOW = 10_000;
const IP_X = "10.0.0.10";
const IP_Y = "10.0.0.20";

for (const algorithm of ALGORITHMS) {
  describe(`/api/resource pipeline [${algorithm}]`, () => {
    const clock = fakeClock();
    let server: TestServer;

    const deploy = async (overrides: Partial<DefenseConfig> = {}) => {
      const config: DefenseConfig = { algorithm, maxRequests: MAX, windowMs: WINDOW, keyBy: "ip", ...overrides };
      const res = await fetch(`${server.baseUrl}/api/defense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      assert.equal(res.status, 200);
    };

    const hit = (token: string | null, ip = IP_X, extra: Record<string, string> = {}) =>
      fetch(`${server.baseUrl}/api/resource`, {
        headers: {
          "X-Forwarded-For": ip,
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          ...extra,
        },
      });

    const statuses = async (n: number, token: string | null, ip = IP_X) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await hit(token, ip)).status);
      return out;
    };

    const valid = (sub: string) => tokens.validToken(sub, clock.now());
    const limiterSize = () => server.app.locals.defense.store.size();

    before(async () => {
      server = await startServer(testEnv(), { now: clock.now });
    });
    after(() => server.close());
    beforeEach(async () => {
      clock.advance(WINDOW * 10);
      await deploy();
    });

    test("valid token under the limit → 200 with sub and rate-limit headers", async () => {
      const res = await hit(valid("alice"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { ok: true, sub: "alice", servedAt: clock.now() });
      assert.equal(res.headers.get("ratelimit-limit"), String(MAX));
      assert.equal(res.headers.get("ratelimit-remaining"), String(MAX - 1));
    });

    test("valid token over the limit → 429 with Retry-After; allowed again after waiting", async () => {
      assert.deepEqual(await statuses(MAX, valid("alice")), Array(MAX).fill(200));
      const res = await hit(valid("alice"));
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.error, "rate_limited");
      assert.ok(body.retryAfterMs > 0);
      assert.equal(res.headers.get("retry-after"), String(Math.max(1, Math.ceil(body.retryAfterMs / 1000))));
      assert.equal(res.headers.get("ratelimit-remaining"), "0");

      clock.advance(body.retryAfterMs);
      assert.equal((await hit(valid("alice"))).status, 200);
    });

    describe("ORDER PROOF: rejected tokens never touch the limiter", () => {
      const attacks: Array<[string, () => string | null]> = [
        ["no token", () => null],
        ["forged signature", () => tokens.forgeSignature("alice", clock.now())],
        ["alg: none", () => tokens.algNone("alice", clock.now())],
        ["expired", () => tokens.expired("alice", clock.now())],
        ["tampered payload", () => tokens.tamperPayload(valid("bob"), "alice")],
        ["garbage", () => "a.b.c"],
      ];
      for (const [name, make] of attacks) {
        test(`50 × ${name} → all 401, then the same IP/user still gets its full budget`, async () => {
          for (const keyBy of ["ip", "user"] as KeyBy[]) {
            await deploy({ keyBy });
            const attack = await statuses(50, make());
            assert.ok(attack.every((s) => s === 401), `${keyBy}: ${attack}`);
            assert.equal(await limiterSize(), 0, `${keyBy}: limiter untouched`);

            assert.deepEqual(await statuses(MAX, valid("alice")), Array(MAX).fill(200), keyBy);
            assert.equal((await hit(valid("alice"))).status, 429, keyBy);
          }
        });
      }
    });

    test("keyBy ip: users behind one IP share a budget; one user on two IPs gets two", async () => {
      await deploy({ keyBy: "ip" });
      assert.deepEqual(await statuses(3, valid("alice"), IP_X), [200, 200, 200]);
      assert.deepEqual(await statuses(3, valid("bob"), IP_X), [200, 200, 429]);
      assert.deepEqual(await statuses(MAX, valid("alice"), IP_Y), Array(MAX).fill(200));
    });

    test("keyBy user: users behind one IP get separate budgets; one user on two IPs shares one", async () => {
      await deploy({ keyBy: "user" });
      assert.deepEqual(await statuses(MAX, valid("alice"), IP_X), Array(MAX).fill(200));
      assert.deepEqual(await statuses(MAX, valid("bob"), IP_X), Array(MAX).fill(200));
      assert.equal((await hit(valid("alice"), IP_Y)).status, 429, "alice's budget follows her across IPs");
    });

    test("redeploy mid-sequence resets the budget", async () => {
      await statuses(MAX, valid("alice"));
      assert.equal((await hit(valid("alice"))).status, 429);
      await deploy();
      assert.equal((await hit(valid("alice"))).status, 200);
    });

    test("redeploy with a new limit takes effect immediately", async () => {
      await deploy({ maxRequests: 7 });
      assert.deepEqual(await statuses(8, valid("alice")), [...Array(7).fill(200), 429]);
    });
  });
}

describe("/api/resource integration", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer(testEnv());
  });
  after(() => server.close());

  test("real login → token → resource (wall clock)", async () => {
    const login = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: demoPassword("bob") }),
    });
    const { token } = await login.json();
    const res = await fetch(`${server.baseUrl}/api/resource`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sub, "bob");
  });

  test("demo expired token → 401 expired, limiter untouched", async () => {
    const r = await fetch(`${server.baseUrl}/api/demo/expired-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: demoPassword("carol") }),
    });
    const { token } = await r.json();
    const before = await server.app.locals.defense.store.size();
    const res = await fetch(`${server.baseUrl}/api/resource`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, "expired");
    assert.equal(await server.app.locals.defense.store.size(), before);
  });

  test("429 headers are readable cross-origin (exposed via CORS)", async () => {
    const res = await fetch(`${server.baseUrl}/api/resource`, { headers: { Origin: "http://localhost:5173" } });
    const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const h of ["retry-after", "ratelimit-limit", "ratelimit-remaining"]) assert.ok(exposed.includes(h), exposed);
  });

  test("health reports the live config and is never limited", async () => {
    await fetch(`${server.baseUrl}/api/defense`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ algorithm: "token", maxRequests: 5, windowMs: 1000, keyBy: "user" }),
    });
    const all = await Promise.all(Array.from({ length: 30 }, () => fetch(`${server.baseUrl}/api/health`)));
    assert.ok(all.every((r) => r.status === 200));
    const body = await all[0]!.json();
    assert.equal(body.status, "healthy");
    assert.equal(body.algorithm, "token");
    assert.equal(body.keyBy, "user");
    assert.equal(typeof body.uptimeS, "number");
  });

  test("non-GET on /api/resource → 404 JSON", async () => {
    const res = await fetch(`${server.baseUrl}/api/resource`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});
