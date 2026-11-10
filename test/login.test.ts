import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { demoPassword, LEGIT_USERS, POOL_USERS, userCount, verifyCredentials } from "../src/config/users.js";
import { LOGIN_LIMIT } from "../src/auth/loginGuard.js";
import { fakeClock, startServer, TEST_SECRET, testEnv, type TestServer } from "./helpers/server.js";

const DEFENSE = { algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" };

describe("demo users", () => {
  test("53 users: 3 legitimate + user01..user50", () => {
    assert.equal(userCount(), 53);
    assert.deepEqual(LEGIT_USERS, ["alice", "bob", "carol"]);
    assert.equal(POOL_USERS.length, 50);
    assert.equal(POOL_USERS[0], "user01");
    assert.equal(POOL_USERS[49], "user50");
    assert.ok(!POOL_USERS.some((u) => LEGIT_USERS.includes(u)), "pools are disjoint");
  });

  test("verifyCredentials", () => {
    for (const u of [...LEGIT_USERS, ...POOL_USERS]) assert.equal(verifyCredentials(u, demoPassword(u)), true, u);
    assert.equal(verifyCredentials("alice", "wrong"), false);
    assert.equal(verifyCredentials("alice", demoPassword("bob")), false);
    assert.equal(verifyCredentials("mallory", demoPassword("mallory")), false);
    assert.equal(verifyCredentials("alice", ""), false);
  });
});

describe("/api/login", () => {
  const clock = fakeClock();
  let server: TestServer;

  const login = (body: unknown, ip = "10.0.0.1", path = "/api/login") =>
    fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify(body),
    });
  const good = (u = "alice") => ({ username: u, password: demoPassword(u) });
  const bad = (u = "alice") => ({ username: u, password: "wrong" });

  before(async () => {
    server = await startServer(testEnv(), { now: clock.now });
  });
  after(() => server.close());
  beforeEach(() => {
    // Fresh login limiter per test, and push time forward so nothing carries over.
    clock.advance(LOGIN_LIMIT.windowMs * 2);
    server.app.locals.loginGuard.reset();
  });

  test("valid credentials → 200 with an HS256 token carrying sub, iat, exp (15 min)", async () => {
    const res = await login(good());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tokenType, "Bearer");
    assert.equal(body.expiresIn, 900);
    assert.equal(body.sub, "alice");

    const decoded = jwt.decode(body.token, { complete: true });
    assert.ok(decoded && typeof decoded.payload === "object");
    assert.equal(decoded.header.alg, "HS256");
    assert.deepEqual(Object.keys(decoded.payload).sort(), ["exp", "iat", "sub"]);
    assert.equal(decoded.payload.sub, "alice");
    assert.equal(decoded.payload.iat, Math.floor(clock.now() / 1000));
    assert.equal(decoded.payload.exp! - decoded.payload.iat!, 900);

    // Signed with the server secret.
    const verified = jwt.verify(body.token, TEST_SECRET, {
      algorithms: ["HS256"],
      clockTimestamp: Math.floor(clock.now() / 1000),
    });
    assert.equal((verified as jwt.JwtPayload).sub, "alice");
  });

  test("wrong password and unknown user get an identical 401", async () => {
    const a = await login(bad("alice"));
    const b = await login({ username: "mallory", password: "whatever" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json());
  });

  test("malformed bodies → 400 and don't count as failures", async () => {
    for (const body of [{}, { username: "alice" }, { username: 1, password: 2 }, { username: "", password: "x" }]) {
      assert.equal((await login(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await login({ username: "a".repeat(65), password: "x" })).status, 400);
    assert.equal(server.app.locals.loginGuard.size(), 0);
    assert.equal((await login(good())).status, 200);
  });

  test("5 failures from IP A → 6th attempt is 429 even with correct creds; IP B unaffected", async () => {
    for (let i = 0; i < LOGIN_LIMIT.maxFailures; i++) assert.equal((await login(bad(), "10.0.0.66")).status, 401);

    const blocked = await login(good(), "10.0.0.66");
    assert.equal(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After=${retryAfter}`);
    const body = await blocked.json();
    assert.equal(body.error, "rate_limited");
    assert.equal(body.retryAfterMs, LOGIN_LIMIT.windowMs);

    assert.equal((await login(good(), "10.0.0.2")).status, 200);
  });

  test("while locked out, credentials aren't checked and failures don't extend the lockout", async () => {
    for (let i = 0; i < LOGIN_LIMIT.maxFailures; i++) await login(bad(), "10.0.0.66");
    clock.advance(30_000);
    for (let i = 0; i < 20; i++) assert.equal((await login(bad(), "10.0.0.66")).status, 429);
    clock.advance(30_000);
    assert.equal((await login(good(), "10.0.0.66")).status, 200, "unlocked exactly one window after the failures");
  });

  test("successful logins don't consume the budget: 50 pool accounts from one IP all succeed", async () => {
    const statuses = [];
    for (const u of POOL_USERS) statuses.push((await login(good(u), "10.0.0.99")).status);
    assert.ok(statuses.every((s) => s === 200), JSON.stringify(statuses));
    assert.equal(server.app.locals.loginGuard.size(), 0);
  });

  test("POST /api/defense clears a login lockout", async () => {
    for (let i = 0; i < LOGIN_LIMIT.maxFailures; i++) await login(bad(), "10.0.0.66");
    assert.equal((await login(good(), "10.0.0.66")).status, 429);

    const deploy = await fetch(`${server.baseUrl}/api/defense`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(DEFENSE),
    });
    assert.equal(deploy.status, 200);
    assert.equal((await login(good(), "10.0.0.66")).status, 200);
  });

  test("the response never contains the secret", async () => {
    const text = await (await login(good())).text();
    assert.ok(!text.includes(TEST_SECRET));
  });

  describe("/api/demo/expired-token", () => {
    test("returns a correctly signed token whose exp is in the past", async () => {
      const res = await login(good("carol"), "10.0.0.3", "/api/demo/expired-token");
      assert.equal(res.status, 200);
      const { token, expired } = await res.json();
      assert.equal(expired, true);
      const nowS = Math.floor(clock.now() / 1000);
      const payload = jwt.decode(token) as jwt.JwtPayload;
      assert.equal(payload.sub, "carol");
      assert.ok(payload.exp! < nowS);
      assert.throws(
        () => jwt.verify(token, TEST_SECRET, { algorithms: ["HS256"], clockTimestamp: nowS }),
        jwt.TokenExpiredError,
      );
      // Signature is valid: verifying while ignoring expiry succeeds.
      jwt.verify(token, TEST_SECRET, { algorithms: ["HS256"], ignoreExpiration: true });
    });

    test("requires valid credentials and shares the login failure limiter", async () => {
      assert.equal((await login(bad("carol"), "10.0.0.3", "/api/demo/expired-token")).status, 401);
      for (let i = 0; i < LOGIN_LIMIT.maxFailures - 1; i++) await login(bad(), "10.0.0.3");
      assert.equal((await login(good("carol"), "10.0.0.3", "/api/demo/expired-token")).status, 429);
    });
  });
});

describe("demo gating", () => {
  test("/api/demo/expired-token is 404 when DEMO_MODE=false", async () => {
    const server = await startServer(testEnv({ DEMO_MODE: "false" }));
    try {
      const res = await fetch(`${server.baseUrl}/api/demo/expired-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: demoPassword("alice") }),
      });
      assert.equal(res.status, 404);
      // Login itself still works.
      const ok = await fetch(`${server.baseUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: demoPassword("alice") }),
      });
      assert.equal(ok.status, 200);
    } finally {
      await server.close();
    }
  });
});
