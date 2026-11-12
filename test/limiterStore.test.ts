/**
 * The async LimiterStore seam (tasks2/02): the request path only talks to a store, so a remote store (Redis) can be
 * swapped in by injecting a factory. In-memory behaviour is covered by every other suite (they run over HTTP).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Algorithm, LimiterOptions, LimiterStore, LimiterStoreFactory } from "../src/algorithms/index.js";
import { MemoryStore, memoryStoreFactory } from "../src/algorithms/memoryStore.js";
import { startServer, testEnv } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

const deploy = (baseUrl: string, algorithm: Algorithm) =>
  fetch(`${baseUrl}/api/defense`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ algorithm, maxRequests: 5, windowMs: 1000, keyBy: "ip" }),
  });

describe("MemoryStore", () => {
  test("wraps the in-memory limiter with the same decisions", async () => {
    const store = memoryStoreFactory("fixed", { maxRequests: 2, windowMs: 1000, epochMs: 0 }) as MemoryStore;
    assert.equal(store.name, "fixed");
    assert.equal((await store.allow("k", 0)).allowed, true);
    assert.equal((await store.allow("k", 0)).allowed, true);
    const denied = await store.allow("k", 0);
    assert.deepEqual(denied, { allowed: false, retryAfterMs: 1000, remaining: 0 });
    assert.equal(await store.size(), 1);
    assert.equal(store.limiter.size(), 1);
  });
});

describe("injected LimiterStoreFactory", () => {
  test("is used for boot and every deploy, with the deploy time as epoch", async () => {
    const calls: Array<{ algorithm: Algorithm; options: LimiterOptions }> = [];
    const factory: LimiterStoreFactory = (algorithm, options) => {
      calls.push({ algorithm, options });
      return memoryStoreFactory(algorithm, options);
    };
    let t = 1_000;
    const server = await startServer(testEnv(), { now: () => t, limiterStoreFactory: factory });
    try {
      t = 5_000;
      assert.equal((await deploy(server.baseUrl, "token")).status, 200);
      assert.deepEqual(calls.map((c) => c.algorithm), ["fixed", "token"]);
      assert.deepEqual(calls[1]!.options, { maxRequests: 5, windowMs: 1000, epochMs: 5_000 });

      const res = await fetch(`${server.baseUrl}/api/resource`, { headers: { Authorization: `Bearer ${tokens.validToken("alice", t)}` } });
      assert.equal(res.status, 200);
    } finally {
      await server.close();
    }
  });

  test("a store that fails → 500 JSON, no stack trace leaked", async (t) => {
    t.mock.method(console, "error", () => {}); // the error handler logs it; keep test output clean
    const broken: LimiterStore = {
      name: "fixed",
      allow: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
      size: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
    };
    const server = await startServer(testEnv(), { limiterStoreFactory: () => broken });
    try {
      const res = await fetch(`${server.baseUrl}/api/resource`, { headers: { Authorization: `Bearer ${tokens.validToken("alice", Date.now())}` } });
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "internal_error" });
      assert.ok(!text.includes("ECONNREFUSED"));

      // Auth still runs first: a bad token is a 401 without touching the broken store.
      const unauth = await fetch(`${server.baseUrl}/api/resource`);
      assert.equal(unauth.status, 401);

      const stats = await fetch(`${server.baseUrl}/api/stats`);
      assert.equal(stats.status, 500);
    } finally {
      await server.close();
    }
  });
});
