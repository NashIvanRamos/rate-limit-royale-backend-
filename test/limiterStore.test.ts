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

  for (const mode of ["open", "closed"] as const) {
    test(`a store that fails follows REDIS_FAILURE_MODE=${mode}, with no internals leaked (tasks2/06)`, async (t) => {
      t.mock.method(console, "warn", () => {}); // the degraded warning; keep test output clean
      const broken: LimiterStore = {
        name: "fixed",
        allow: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
        size: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
      };
      const server = await startServer(testEnv({ REDIS_FAILURE_MODE: mode }), { limiterStoreFactory: () => broken });
      try {
        const res = await fetch(`${server.baseUrl}/api/resource`, { headers: { Authorization: `Bearer ${tokens.validToken("alice", Date.now())}` } });
        const text = await res.text();
        assert.ok(!text.includes("ECONNREFUSED"));
        if (mode === "open") {
          assert.equal(res.status, 200);
          assert.equal(res.headers.get("x-ratelimit-degraded"), "true");
        } else {
          assert.equal(res.status, 503);
          assert.deepEqual(JSON.parse(text), { error: "limiter_unavailable" });
          assert.equal(res.headers.get("retry-after"), "1");
        }

        // Auth still runs first: a bad token is a 401 without touching the broken store.
        assert.equal((await fetch(`${server.baseUrl}/api/resource`)).status, 401);
        assert.equal((await fetch(`${server.baseUrl}/api/stats`)).status, 503);
      } finally {
        await server.close();
      }
    });
  }
});
