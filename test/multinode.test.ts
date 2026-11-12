/**
 * Multi-node replay support (tasks2/01): deploy to every node, sum their stats. In-process servers, fake clock.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StatsSnapshot } from "../src/middleware/stats.js";
import { getScenario } from "../src/scenarios/rounds.js";
import { replay, sumStats } from "../scripts/replayEngine.js";
import { fakeRunnerClock } from "./helpers/clock.js";
import { startServer, testEnv } from "./helpers/server.js";

const snap = (over: Partial<StatsSnapshot> & { r200?: number; l401?: number; keys?: StatsSnapshot["topKeys"] }): StatsSnapshot => ({
  since: over.since ?? 0,
  resource: { total: over.r200 ?? 0, s200: over.r200 ?? 0, s401: 0, s429: 0, other: 0, byReason: { missing_token: 0, invalid_signature: 0, expired: 0, malformed: 0 } },
  login: { total: over.l401 ?? 0, s200: 0, s400: 0, s401: over.l401 ?? 0, s429: 0, other: 0 },
  trackedKeys: over.trackedKeys ?? 0,
  topKeys: over.keys ?? [],
  untrackedKeyRequests: 0,
});

describe("sumStats", () => {
  test("adds counters, merges keys across nodes, keeps the earliest since", () => {
    const sum = sumStats([
      snap({ since: 20, r200: 10, l401: 5, trackedKeys: 2, keys: [{ key: "ip:10.6.6.6", requests: 100, allowed: 10, blocked: 90 }] }),
      snap({ since: 10, r200: 11, l401: 5, trackedKeys: 2, keys: [{ key: "ip:10.6.6.6", requests: 100, allowed: 10, blocked: 90 }, { key: "ip:10.0.0.1", requests: 3, allowed: 3, blocked: 0 }] }),
    ]);
    assert.equal(sum.since, 10);
    assert.equal(sum.resource.s200, 21);
    assert.equal(sum.resource.byReason.expired, 0);
    assert.equal(sum.login.s401, 10);
    assert.equal(sum.trackedKeys, 4);
    assert.deepEqual(sum.topKeys[0], { key: "ip:10.6.6.6", requests: 200, allowed: 20, blocked: 180 });
    assert.equal(sum.topKeys.length, 2);
  });

  test("a single snapshot passes through unchanged", () => {
    const one = snap({ r200: 3 });
    assert.equal(sumStats([one]), one);
  });
});

describe("replay with controlUrls", () => {
  test("deploys to every node and cross-checks against the summed stats", async () => {
    const { clock, now } = fakeRunnerClock();
    const a = await startServer(testEnv({ NODE_ID: "a" }), { now });
    const b = await startServer(testEnv({ NODE_ID: "b" }), { now });
    try {
      const config = { algorithm: "sliding" as const, maxRequests: 7, windowMs: 5_000, keyBy: "user" as const };
      const r = await replay({
        baseUrl: a.baseUrl, // all traffic to node a; node b only receives the deploy
        controlUrls: [a.baseUrl, b.baseUrl],
        scenario: getScenario(4),
        config,
        clock,
        sequential: true,
      });
      assert.deepEqual(r.statsCheck.mismatches, []);
      assert.deepEqual(Object.keys(r.nodeSplit), ["a"]);
      const onB = (await (await fetch(`${b.baseUrl}/api/defense`)).json()) as { config: typeof config };
      assert.deepEqual(onB.config, config, "node b got the deploy too");
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("tolerateDeadNodes: a node that dies mid-round is reported, not fatal", async () => {
    const { clock, now } = fakeRunnerClock();
    const a = await startServer(testEnv({ NODE_ID: "a" }), { now });
    const b = await startServer(testEnv({ NODE_ID: "b" }), { now });
    try {
      const r = await replay({
        baseUrl: a.baseUrl,
        controlUrls: [a.baseUrl, b.baseUrl],
        scenario: getScenario(1),
        config: { algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" },
        clock,
        sequential: true,
        tolerateDeadNodes: true,
        onFireStart: () => void b.close(),
      });
      assert.equal(r.statsCheck.matches, false);
      assert.match(r.statsCheck.mismatches[0]!, /unreachable/);
      assert.equal(r.statsCheck.mismatches.length, 1, "node a's own numbers still match");
    } finally {
      await a.close();
    }
  });
});
