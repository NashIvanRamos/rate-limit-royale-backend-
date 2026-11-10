import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { EnvError, loadEnv } from "../src/config/env.js";
import { startServer, TEST_SECRET, type TestServer } from "./helpers/server.js";

describe("loadEnv", () => {
  test("throws when JWT_SECRET is missing", () => {
    assert.throws(() => loadEnv({}), (e: unknown) => e instanceof EnvError && /JWT_SECRET is required/.test(e.message));
  });

  test("throws when JWT_SECRET is too short, without leaking it", () => {
    assert.throws(
      () => loadEnv({ JWT_SECRET: "short-secret" }),
      (e: unknown) => e instanceof EnvError && /at least 32/.test(e.message) && !e.message.includes("short-secret"),
    );
  });

  test("rejects an invalid PORT and DEMO_MODE together", () => {
    assert.throws(
      () => loadEnv({ JWT_SECRET: TEST_SECRET, PORT: "abc", DEMO_MODE: "maybe" }),
      (e: unknown) => e instanceof EnvError && /PORT/.test(e.message) && /DEMO_MODE/.test(e.message),
    );
  });

  test("applies defaults and returns a frozen object", () => {
    const env = loadEnv({ JWT_SECRET: TEST_SECRET });
    assert.equal(env.PORT, 3000);
    assert.equal(env.DEMO_MODE, false);
    assert.equal(env.TRUST_PROXY, "loopback");
    assert.equal(env.CORS_ORIGIN, "http://localhost:5173");
    assert.ok(Object.isFrozen(env));
  });

  test("parses TRUST_PROXY booleans and hop counts", () => {
    assert.equal(loadEnv({ JWT_SECRET: TEST_SECRET, TRUST_PROXY: "false" }).TRUST_PROXY, false);
    assert.equal(loadEnv({ JWT_SECRET: TEST_SECRET, TRUST_PROXY: "2" }).TRUST_PROXY, 2);
  });
});

describe("app", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });

  test("GET /api/health returns 200", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "healthy");
  });

  test("temporary /api/protected route is gone", async () => {
    const res = await fetch(`${server.baseUrl}/api/protected`);
    assert.equal(res.status, 404);
  });

  test("CORS allows the configured origin and exposes Retry-After", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /Retry-After/);
  });

  test("CORS preflight allows Authorization and X-Forwarded-For", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,x-forwarded-for",
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.ok(allowed.includes("authorization") && allowed.includes("x-forwarded-for"));
  });

  test("does not advertise Express", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});
