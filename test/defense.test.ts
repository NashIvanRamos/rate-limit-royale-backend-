import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEFENSE, DefenseState, validateDefenseConfig, type DefenseConfig } from "../src/config/defense.js";
import { fakeClock, startServer, testEnv, type TestServer } from "./helpers/server.js";

const VALID: DefenseConfig = { algorithm: "sliding", maxRequests: 20, windowMs: 5000, keyBy: "user" };

describe("validateDefenseConfig", () => {
  test("accepts a valid config", () => {
    assert.deepEqual(validateDefenseConfig(VALID), { ok: true, config: VALID });
  });

  test("accepts range boundaries", () => {
    for (const [maxRequests, windowMs] of [
      [5, 1000],
      [100, 60000],
    ]) {
      assert.equal(validateDefenseConfig({ ...VALID, maxRequests, windowMs }).ok, true);
    }
  });

  const invalid: Array<[string, unknown, string]> = [
    ["not an object", "hello", "body"],
    ["array body", [VALID], "body"],
    ["null body", null, "body"],
    ["unknown algorithm", { ...VALID, algorithm: "leaky" }, "algorithm"],
    ["unknown keyBy", { ...VALID, keyBy: "header" }, "keyBy"],
    ["maxRequests below range", { ...VALID, maxRequests: 4 }, "maxRequests"],
    ["maxRequests above range", { ...VALID, maxRequests: 101 }, "maxRequests"],
    ["maxRequests non-integer", { ...VALID, maxRequests: 10.5 }, "maxRequests"],
    ["maxRequests as string", { ...VALID, maxRequests: "10" }, "maxRequests"],
    ["windowMs below range", { ...VALID, windowMs: 999 }, "windowMs"],
    ["windowMs above range", { ...VALID, windowMs: 60001 }, "windowMs"],
    ["windowMs NaN-like", { ...VALID, windowMs: null }, "windowMs"],
    ["missing field", { algorithm: "fixed", maxRequests: 10, windowMs: 1000 }, "keyBy"],
    ["extra field", { ...VALID, xClientId: "me" }, "xClientId"],
  ];
  for (const [name, body, field] of invalid) {
    test(`rejects ${name}`, () => {
      const r = validateDefenseConfig(body);
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.issues.some((i) => i.field === field), JSON.stringify(r.issues));
    });
  }

  test("reports all issues at once", () => {
    const r = validateDefenseConfig({ algorithm: "x", maxRequests: 0, windowMs: 0, keyBy: "x" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.issues.length, 4);
  });
});

describe("DefenseState", () => {
  test("boots with the default config", () => {
    const s = new DefenseState(1000);
    assert.deepEqual(s.config, DEFAULT_DEFENSE);
    assert.equal(s.limiter.name, "fixed");
    assert.equal(s.deployedAt, 1000);
  });

  test("deploy resets limiter state", () => {
    const s = new DefenseState(0, { ...VALID, maxRequests: 5 });
    for (let i = 0; i < 5; i++) s.limiter.allow("ip:1.1.1.1", 10);
    assert.equal(s.limiter.allow("ip:1.1.1.1", 10).allowed, false);

    s.deploy({ ...VALID, maxRequests: 5 }, 20);
    assert.equal(s.limiter.size(), 0);
    assert.equal(s.limiter.allow("ip:1.1.1.1", 20).allowed, true);
  });

  test("switching algorithm changes the limiter", () => {
    const s = new DefenseState(0);
    for (const algorithm of ["sliding", "token", "fixed"] as const) {
      s.deploy({ ...VALID, algorithm }, 0);
      assert.equal(s.limiter.name, algorithm);
    }
  });

  test("fixed windows align to deploy time", () => {
    const s = new DefenseState(0);
    const snap = s.deploy({ algorithm: "fixed", maxRequests: 5, windowMs: 1000, keyBy: "ip" }, 12_345);
    assert.equal(snap.windowEpochMs, 12_345);
    for (let i = 0; i < 5; i++) s.limiter.allow("k", 12_345);
    assert.equal(s.limiter.allow("k", 12_345 + 999).retryAfterMs, 1);
    assert.equal(s.limiter.allow("k", 12_345 + 1000).allowed, true);
  });

  test("reset listeners run on every deploy", () => {
    const s = new DefenseState(0);
    let calls = 0;
    s.onReset(() => calls++);
    s.deploy(VALID, 1);
    s.deploy(VALID, 2);
    assert.equal(calls, 2);
  });

  test("snapshot is a copy, not live state", () => {
    const s = new DefenseState(0);
    const snap = s.snapshot();
    snap.config.maxRequests = 999;
    assert.equal(s.config.maxRequests, DEFAULT_DEFENSE.maxRequests);
  });
});

describe("/api/defense over HTTP", () => {
  const clock = fakeClock();
  let server: TestServer;
  const post = (body: unknown, raw = false) =>
    fetch(`${server.baseUrl}/api/defense`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    });

  before(async () => {
    server = await startServer(testEnv(), { now: clock.now });
  });
  after(() => server.close());
  beforeEach(() => clock.advance(1000));

  test("GET returns the current (default) config", async () => {
    const res = await fetch(`${server.baseUrl}/api/defense`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.config, DEFAULT_DEFENSE);
    assert.equal(typeof body.deployedAt, "number");
  });

  test("POST valid config → 200 echoing config, deployedAt and windowEpochMs", async () => {
    const res = await post(VALID);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { config: VALID, deployedAt: clock.now(), windowEpochMs: clock.now() });

    const current = await (await fetch(`${server.baseUrl}/api/defense`)).json();
    assert.deepEqual(current.config, VALID);
    assert.equal(server.app.locals.defense.limiter.name, "sliding");
  });

  test("POST resets limiter state", async () => {
    await post({ ...VALID, maxRequests: 5 });
    const { defense } = server.app.locals;
    for (let i = 0; i < 6; i++) defense.limiter.allow("ip:9.9.9.9", clock.now());
    assert.equal(defense.limiter.allow("ip:9.9.9.9", clock.now()).allowed, false);

    await post({ ...VALID, maxRequests: 5 });
    assert.equal(server.app.locals.defense.limiter.size(), 0);
    assert.equal(server.app.locals.defense.limiter.allow("ip:9.9.9.9", clock.now()).allowed, true);
  });

  test("POST invalid config → 400 with details, config unchanged", async () => {
    await post(VALID);
    const res = await post({ ...VALID, maxRequests: 1000, extra: true });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_config");
    assert.deepEqual(body.details.map((d: { field: string }) => d.field).sort(), ["extra", "maxRequests"]);
    assert.deepEqual(server.app.locals.defense.config, VALID);
  });

  test("POST malformed JSON → 400 JSON error, not HTML", async () => {
    const res = await post("{not json", true);
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.equal((await res.json()).error, "bad_request");
  });

  test("POST without a JSON content type → 400", async () => {
    const res = await fetch(`${server.baseUrl}/api/defense`, { method: "POST", body: "algorithm=fixed" });
    assert.equal(res.status, 400);
  });

  test("never rate limited: many rapid deploys all succeed", async () => {
    const statuses = await Promise.all(Array.from({ length: 50 }, () => post(VALID).then((r) => r.status)));
    assert.ok(statuses.every((s) => s === 200));
  });

  test("unknown route → JSON 404", async () => {
    const res = await fetch(`${server.baseUrl}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "not_found");
  });
});
