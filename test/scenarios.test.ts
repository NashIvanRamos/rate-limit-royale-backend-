/**
 * Per-round expectations (task 09, design doc §7, §12). Each test replays a round over HTTP against a fresh app
 * on a fake clock, so the full 10s rounds run instantly and deterministically. Every replay also asserts that
 * its own tally matches GET /api/stats exactly.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ALGORITHMS, type Algorithm } from "../src/algorithms/index.js";
import type { DefenseConfig, KeyBy } from "../src/config/defense.js";
import { attackProfile, score, tally } from "../src/scenarios/results.js";
import { ATTACKER_IP, SCENARIOS, getScenario } from "../src/scenarios/rounds.js";
import type { RequestRecord } from "../src/scenarios/types.js";
import { replay, type ReplayResult } from "../scripts/replayEngine.js";
import { fakeRunnerClock } from "./helpers/clock.js";
import { startServer, testEnv } from "./helpers/server.js";

const BASE: DefenseConfig = { algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" };

async function run(round: number, overrides: Partial<DefenseConfig> = {}): Promise<ReplayResult> {
  const { clock, now } = fakeRunnerClock();
  const server = await startServer(testEnv(), { now });
  try {
    const result = await replay({
      baseUrl: server.baseUrl,
      scenario: getScenario(round),
      config: { ...BASE, ...overrides },
      clock,
      sequential: true,
    });
    assert.deepEqual(result.statsCheck.mismatches, [], "replay tally must match /api/stats exactly");
    assert.equal(result.tally.errors, 0);
    return result;
  } finally {
    await server.close();
  }
}

const attackerRecords = (r: ReplayResult) => r.records.filter((x) => !x.legit);
const passed = (records: RequestRecord[]) => records.filter((x) => x.status === 200);

describe("scenario definitions", () => {
  test("five rounds, ids 1–5, each with 2–3 legit clients on their own IPs", () => {
    assert.deepEqual(SCENARIOS.map((s) => s.id), [1, 2, 3, 4, 5]);
    for (const s of SCENARIOS) {
      const legit = s.clients.filter((c) => c.legit);
      assert.ok(legit.length >= 2 && legit.length <= 3, `round ${s.id} has ${legit.length} legit clients`);
      assert.ok(legit.every((c) => !c.ip.startsWith("10.6.6.")), `round ${s.id}: legit clients never share attacker IPs`);
      assert.equal(new Set(s.clients.map((c) => c.id)).size, s.clients.length, "client ids are unique");
    }
  });

  test("built events are sorted, reference known clients, and stay within ~1s past the nominal duration", () => {
    for (const s of SCENARIOS) {
      const events = s.build({ config: BASE, windowEpochMs: 0, startAt: 0 });
      const ids = new Set(s.clients.map((c) => c.id));
      assert.ok(events.every((e, i) => i === 0 || events[i - 1]!.at <= e.at), `round ${s.id} sorted`);
      assert.ok(events.every((e) => ids.has(e.clientId)), `round ${s.id} known clients`);
      assert.ok(Math.max(...events.map((e) => e.at)) <= s.durationMs + 1_000, `round ${s.id} duration`);
    }
  });
});

describe("Round 1: Steady Flood", () => {
  for (const algorithm of ALGORITHMS) {
    test(`${algorithm}: blocks most attacker traffic with 0 legit blocks, and clears`, async () => {
      const r = await run(1, { algorithm });
      assert.equal(r.tally.attackTotal, 200);
      assert.ok(r.tally.attackStopped / r.tally.attackTotal >= 0.85, `stopped ${r.tally.attackStopped}/200`);
      assert.equal(r.tally.legitBlocks, 0);
      assert.ok(r.score.cleared, `containment ${r.score.containment}`);
    });
  }
});

describe("Round 2: Edge Exploit", () => {
  test("fixed window lets 2× the quota through across the boundary, and doesn't clear", async () => {
    const r = await run(2, { algorithm: "fixed" });
    assert.equal(r.tally.attackPassed, 2 * BASE.maxRequests);
    assert.equal(r.tally.legitBlocks, 0);
    assert.equal(r.score.cleared, false);
    assert.ok(r.score.containment < 0.7);
  });

  test("the two bursts straddle a real fixed-window boundary", async () => {
    const r = await run(2, { algorithm: "fixed" });
    const bursts = [...new Set(attackerRecords(r).map((x) => x.at))];
    assert.equal(bursts.length, 2);
    const [before, after] = bursts.map((at) => r.startAt + at) as [number, number];
    // Window epoch = deploy time = startAt on the fake clock (setup takes no time).
    const windowOf = (t: number) => Math.floor((t - r.startAt) / BASE.windowMs);
    assert.equal(windowOf(after), windowOf(before) + 1);
    assert.equal(after - before, 500);
  });

  for (const algorithm of ["sliding", "token"] as const) {
    test(`${algorithm}: at most 1× the quota gets through, and clears`, async () => {
      const r = await run(2, { algorithm });
      assert.ok(r.tally.attackPassed <= BASE.maxRequests, `passed ${r.tally.attackPassed}`);
      assert.equal(r.tally.legitBlocks, 0);
      assert.ok(r.score.cleared);
    });
  }
});

describe("Round 3: Burst Attack", () => {
  const config = { maxRequests: 10, windowMs: 2_000 };

  test("token bucket admits the initial burst, then the refill rate", async () => {
    const r = await run(3, { ...config, algorithm: "token" });
    const attack = attackerRecords(r);
    assert.ok(attack.slice(0, config.maxRequests).every((x) => x.status === 200), "first `capacity` requests pass");
    const lastAt = attack.at(-1)!.at;
    const expected = config.maxRequests + Math.floor((lastAt * config.maxRequests) / config.windowMs);
    assert.ok(Math.abs(passed(attack).length - expected) <= 1, `passed ${passed(attack).length}, expected ≈${expected}`);
    assert.equal(r.tally.legitBlocks, 0);
  });

  test("sliding window admits exactly max per window, never more in any windowMs span", async () => {
    const r = await run(3, { ...config, algorithm: "sliding" });
    const times = passed(attackerRecords(r)).map((x) => x.at);
    for (const t of times) {
      const inSpan = times.filter((u) => u > t - config.windowMs && u <= t).length;
      assert.ok(inSpan <= config.maxRequests, `${inSpan} accepted in the ${config.windowMs}ms ending at ${t}`);
    }
    // 100 requests over 5s, 2s windows → three windows' worth.
    assert.equal(times.length, 3 * config.maxRequests);
  });

  test("token bucket is more permissive than sliding for the same config", async () => {
    const token = await run(3, { ...config, algorithm: "token" });
    const sliding = await run(3, { ...config, algorithm: "sliding" });
    assert.ok(token.tally.attackPassed > sliding.tally.attackPassed);
  });
});

describe("Round 4: Credential Stuffing + Forged Tokens", () => {
  for (const keyBy of ["ip", "user"] as const) {
    test(`keyBy ${keyBy}: login lockout, forged tokens 401, expired legit is not a legit block`, async () => {
      const r = await run(4, { keyBy });

      const logins = r.records.filter((x) => x.path === "/api/login").map((x) => x.status);
      assert.equal(logins.length, 60);
      assert.deepEqual(logins.slice(0, 5), [401, 401, 401, 401, 401], "5 failures allowed");
      assert.ok(logins.slice(5).every((s) => s === 429), "then locked out");

      for (const id of ["forger", "unsigned"]) {
        const rs = r.records.filter((x) => x.clientId === id);
        assert.ok(rs.length > 0 && rs.every((x) => x.status === 401 && x.reason === "invalid_signature"), id);
      }

      const carol = r.records.filter((x) => x.clientId === "carol");
      assert.ok(carol.length > 0 && carol.every((x) => x.status === 401 && x.reason === "expired"));
      assert.equal(r.tally.legitExpired, carol.length);
      assert.equal(r.tally.legitBlocks, 0, "401s never count as legit blocks");

      // Forgers impersonated alice and bob, but never touched their budgets.
      for (const id of ["alice", "bob"]) {
        assert.ok(r.records.filter((x) => x.clientId === id).every((x) => x.status === 200), id);
      }
      assert.equal(r.stats.trackedKeys, 2, "only alice and bob reached the limiter");
      assert.ok(r.score.cleared);
    });
  }
});

describe("Round 5: Account-Rotation Boss Wave", () => {
  for (const algorithm of ALGORITHMS) {
    test(`${algorithm}: keying by user lets ≥10× more attack traffic through than keying by IP`, async () => {
      const byUser = await run(5, { algorithm, keyBy: "user" });
      const byIp = await run(5, { algorithm, keyBy: "ip" });

      assert.equal(byUser.setupLogins, 53, "all 50 pool accounts + 3 legit log in (failure-only login limiting)");
      assert.equal(byUser.tally.attackTotal, 300);
      assert.ok(
        byUser.tally.attackPassed >= 10 * byIp.tally.attackPassed,
        `user ${byUser.tally.attackPassed} vs ip ${byIp.tally.attackPassed}`,
      );
      assert.ok(byIp.tally.attackPassed <= 2 * BASE.maxRequests, "IP keying caps the attacker near 1× quota");

      for (const r of [byUser, byIp]) assert.equal(r.tally.legitBlocks, 0, "legit users on their own IPs are unaffected");

      // The keying story, from the server's own per-key stats.
      assert.equal(byIp.stats.topKeys[0]!.key, `ip:${ATTACKER_IP}`);
      assert.ok(byUser.stats.trackedKeys >= 50);

      assert.ok(byIp.score.cleared);
      assert.equal(byUser.score.cleared, false);
      assert.ok(byUser.score.xpEarned < 100, `user keying XP ${byUser.score.xpEarned}`);
    });
  }
});

describe("legitBlocks never includes 401s, in any round", () => {
  for (const s of SCENARIOS) {
    test(`round ${s.id}`, async () => {
      const r = await run(s.id, { algorithm: "sliding" as Algorithm, keyBy: "ip" as KeyBy });
      const legit429 = r.records.filter((x) => x.legit && x.status === 429).length;
      assert.equal(r.tally.legitBlocks, legit429);
    });
  }
});

describe("reference scoring", () => {
  test("an over-tight defense (5 per 60s) produces legit blocks and a heavy penalty", async () => {
    const r = await run(1, { maxRequests: 5, windowMs: 60_000 });
    assert.ok(r.tally.legitBlocks > 0);
    assert.equal(r.score.cleared, false);
    assert.ok(r.score.xpEarned <= 400);
  });

  test("formula: allowance is one quota plus the sustained rate, per attacker IP", () => {
    const clients = [
      { id: "a", ip: "10.6.6.6", legit: false, auth: { type: "none" as const } },
      { id: "b", ip: "10.6.6.7", legit: false, auth: { type: "none" as const } },
    ];
    const events = [
      { at: 0, clientId: "a", path: "/api/resource" as const },
      { at: 5_000, clientId: "b", path: "/api/resource" as const },
    ];
    const profile = attackProfile(events, clients);
    assert.deepEqual(profile, { attackDurationMs: 5_000, attackerIpCount: 2 });

    const config = { maxRequests: 10, windowMs: 10_000 };
    const record = (status: number, legit = false): RequestRecord => ({ at: 0, clientId: "a", path: "/api/resource", legit, status, latencyMs: 1 });

    const perfect = score(tally([...Array(30)].map(() => record(200))), config, profile);
    assert.equal(perfect.allowance, 30);
    assert.equal(perfect.containment, 1);
    assert.equal(perfect.xpEarned, 500);

    const leaky = score(tally([...Array(69)].map(() => record(200))), config, profile);
    assert.equal(leaky.containment, (30 * 1.15) / 69);

    const legitHit = score(tally([record(429, true), record(429, true), record(401, true)]), config, profile);
    assert.equal(legitHit.legitPenalty, 0.2, "two 429s cost XP, the 401 doesn't");
    assert.equal(legitHit.xpEarned, 400);
    assert.equal(legitHit.cleared, false);
  });
});
