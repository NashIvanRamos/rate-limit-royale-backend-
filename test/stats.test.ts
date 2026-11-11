import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DefenseConfig } from "../src/config/defense.js";
import { demoPassword } from "../src/config/users.js";
import { MAX_TRACKED_KEYS, StatsCollector, TOP_KEYS, type StatsSnapshot } from "../src/middleware/stats.js";
import { fakeClock, startServer, testEnv, type TestServer } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

const MAX = 5;
const WINDOW = 10_000;

describe("GET /api/stats", () => {
  const clock = fakeClock();
  let server: TestServer;

  const deploy = async (overrides: Partial<DefenseConfig> = {}) => {
    const config: DefenseConfig = { algorithm: "fixed", maxRequests: MAX, windowMs: WINDOW, keyBy: "ip", ...overrides };
    const res = await fetch(`${server.baseUrl}/api/defense`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    assert.equal(res.status, 200);
  };

  const resource = async (token: string | null, ip = "10.0.0.1") => {
    const res = await fetch(`${server.baseUrl}/api/resource`, {
      headers: { "X-Forwarded-For": ip, ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    });
    await res.body?.cancel();
    return res.status;
  };

  const login = async (body: string, ip = "10.0.0.1") => {
    const res = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body,
    });
    await res.body?.cancel();
    return res.status;
  };

  const creds = (username: string, password = demoPassword(username)) => JSON.stringify({ username, password });

  const stats = async (): Promise<StatsSnapshot> => {
    const res = await fetch(`${server.baseUrl}/api/stats`);
    assert.equal(res.status, 200);
    return (await res.json()) as StatsSnapshot;
  };

  const valid = (sub: string) => tokens.validToken(sub, clock.now());

  before(async () => {
    server = await startServer(testEnv(), { now: clock.now });
  });
  after(() => server.close());
  beforeEach(async () => {
    clock.advance(WINDOW * 10);
    await deploy();
  });

  test("starts at zero after a deploy, with since = deploy time", async () => {
    const s = await stats();
    assert.equal(s.since, clock.now());
    assert.deepEqual(s.resource, {
      total: 0,
      s200: 0,
      s401: 0,
      s429: 0,
      other: 0,
      byReason: { missing_token: 0, invalid_signature: 0, expired: 0, malformed: 0 },
    });
    assert.deepEqual(s.login, { total: 0, s200: 0, s400: 0, s401: 0, s429: 0, other: 0 });
    assert.equal(s.trackedKeys, 0);
    assert.deepEqual(s.topKeys, []);
  });

  test("a mixed burst is counted exactly, including each 401 reason", async () => {
    const t = valid("alice");
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push(await resource(t)); // 5 × 200, 3 × 429
    seen.push(await resource(null)); // missing_token
    seen.push(await resource(tokens.forgeSignature("alice", clock.now()))); // invalid_signature
    seen.push(await resource(tokens.algNone("alice", clock.now()))); // invalid_signature
    seen.push(await resource(tokens.expired("alice", clock.now()))); // expired
    seen.push(await resource("a.b.c")); // malformed

    const count = (code: number) => seen.filter((s) => s === code).length;
    const s = await stats();
    assert.deepEqual(s.resource, {
      total: 13,
      s200: count(200),
      s401: count(401),
      s429: count(429),
      other: 0,
      byReason: { missing_token: 1, invalid_signature: 2, expired: 1, malformed: 1 },
    });
    assert.equal(s.resource.s200, MAX);
    assert.equal(s.resource.s429, 3);
    assert.equal(s.resource.s200 + s.resource.s401 + s.resource.s429, s.resource.total);
  });

  test("login outcomes are counted, including malformed JSON rejected by the body parser", async () => {
    assert.equal(await login(creds("alice")), 200);
    assert.equal(await login(JSON.stringify({ username: "alice" })), 400);
    assert.equal(await login("{not json"), 400);
    for (let i = 0; i < 5; i++) assert.equal(await login(creds("alice", "wrong"), "10.0.0.9"), 401);
    assert.equal(await login(creds("alice", "wrong"), "10.0.0.9"), 429);

    const s = await stats();
    assert.deepEqual(s.login, { total: 9, s200: 1, s400: 2, s401: 5, s429: 1, other: 0 });
    assert.equal(s.resource.total, 0);
  });

  test("deploy resets the stats", async () => {
    await resource(valid("alice"));
    await resource(null);
    await login(creds("alice"));
    assert.equal((await stats()).resource.total, 2);

    clock.advance(1_234);
    await deploy({ algorithm: "token" });
    const s = await stats();
    assert.equal(s.since, clock.now());
    assert.equal(s.resource.total, 0);
    assert.equal(s.login.total, 0);
    assert.deepEqual(s.topKeys, []);
    assert.equal(s.trackedKeys, 0);
  });

  test("stats, health, defense and demo calls are not counted", async () => {
    await stats();
    await stats();
    await (await fetch(`${server.baseUrl}/api/health`)).body?.cancel();
    await (await fetch(`${server.baseUrl}/api/defense`)).body?.cancel();
    await (await fetch(`${server.baseUrl}/api/demo/whoami`)).body?.cancel();
    const res = await fetch(`${server.baseUrl}/api/demo/expired-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: creds("alice"),
    });
    await res.body?.cancel();

    const s = await stats();
    assert.equal(s.resource.total, 0);
    assert.equal(s.login.total, 0);
  });

  test("a non-GET to /api/resource lands in `other`, so total stays honest", async () => {
    const res = await fetch(`${server.baseUrl}/api/resource`, { method: "POST" });
    await res.body?.cancel();
    assert.equal(res.status, 404);
    const s = await stats();
    assert.equal(s.resource.total, 1);
    assert.equal(s.resource.other, 1);
  });

  test("trackedKeys reports the limiter's live key count", async () => {
    await resource(valid("alice"), "10.0.0.1");
    await resource(valid("alice"), "10.0.0.2");
    await resource(valid("alice"), "10.0.0.3");
    await resource(null, "10.0.0.4"); // 401: never reaches the limiter
    assert.equal((await stats()).trackedKeys, 3);
  });

  test("round 5 talking point: one IP key under keyBy ip vs. many user keys under keyBy user", async () => {
    const attackers = ["user01", "user02", "user03", "user04", "user05", "user06", "user07"];
    const attackerIp = "10.0.0.66";

    // keyBy ip: every account shares the attacker's IP key.
    for (const u of attackers) await resource(valid(u), attackerIp);
    let s = await stats();
    assert.deepEqual(s.topKeys, [{ key: `ip:${attackerIp}`, requests: 7, allowed: MAX, blocked: 2 }]);

    // keyBy user: each account gets its own budget.
    await deploy({ keyBy: "user" });
    for (const u of attackers) await resource(valid(u), attackerIp);
    s = await stats();
    assert.equal(s.topKeys.length, attackers.length);
    assert.ok(s.topKeys.every((k) => k.key.startsWith("user:") && k.allowed === 1 && k.blocked === 0));
    assert.equal(s.trackedKeys, attackers.length);
  });
});

describe("StatsCollector", () => {
  test("topKeys is the top 10 by requests, ties broken by key", () => {
    const c = new StatsCollector(0);
    for (let i = 0; i < 15; i++) {
      for (let n = 0; n <= i; n++) c.recordResource(200, undefined, `ip:10.0.0.${i}`);
    }
    const top = c.snapshot(0).topKeys;
    assert.equal(top.length, TOP_KEYS);
    assert.equal(top[0]!.key, "ip:10.0.0.14");
    assert.equal(top[0]!.requests, 15);
    assert.equal(top.at(-1)!.key, "ip:10.0.0.5");
  });

  test("per-key tracking is bounded", () => {
    const c = new StatsCollector(0);
    for (let i = 0; i < MAX_TRACKED_KEYS + 3; i++) c.recordResource(200, undefined, `ip:${i}`);
    c.recordResource(429, undefined, "ip:0"); // existing key still updates
    const s = c.snapshot(0);
    assert.equal(s.untrackedKeyRequests, 3);
    assert.equal(s.resource.total, MAX_TRACKED_KEYS + 4);
    assert.deepEqual(s.topKeys[0], { key: "ip:0", requests: 2, allowed: 1, blocked: 1 });
  });

  test("snapshot is a copy: mutating it doesn't touch the collector", () => {
    const c = new StatsCollector(0);
    c.recordResource(401, "expired");
    const s = c.snapshot(0);
    s.resource.byReason.expired = 99;
    s.resource.total = 99;
    assert.equal(c.snapshot(0).resource.byReason.expired, 1);
    assert.equal(c.snapshot(0).resource.total, 1);
  });
});
