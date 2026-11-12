/**
 * The five rounds (design doc §7), with the numbers from Frontend-Steps §4.
 *
 * Every round has 2–3 legitimate clients sending ~1 request every 1.5s, so "legitimate blocks" means something:
 * an over-tight defense (for example 5 per 60s) blocks them.
 *
 * Attackers in rounds 1–3 and 5 are AUTHENTICATED (they log in with pool accounts). /api/resource runs auth
 * before the limiter, so an unauthenticated flood would be 100% 401s whatever the config and would never
 * exercise the limiter. Unauthenticated and forged traffic is round 4's job.
 */
import { POOL_USERS } from "../config/users.js";
import type { ClientSpec, Scenario, ScenarioEvent } from "./types.js";

export const ATTACKER_IP = "10.6.6.6";
export const LEGIT_INTERVAL_MS = 1_500;

const legit = {
  alice: { id: "alice", ip: "10.0.0.1", legit: true, auth: { type: "login", username: "alice" } },
  bob: { id: "bob", ip: "10.0.0.2", legit: true, auth: { type: "login", username: "bob" } },
  carol: { id: "carol", ip: "10.0.0.3", legit: true, auth: { type: "login", username: "carol" } },
} satisfies Record<string, ClientSpec>;

/** The main attacker for rounds 1–3: one pool account on the attacker IP. */
const attacker: ClientSpec = { id: "attacker", ip: ATTACKER_IP, legit: false, auth: { type: "login", username: "user01" } };

/** Each legit client sends one request every 1.5s, staggered by 500ms so they don't all fire on the same tick. */
export function legitTraffic(clientIds: string[], durationMs: number): ScenarioEvent[] {
  return clientIds.flatMap((clientId, i) => {
    const events: ScenarioEvent[] = [];
    for (let at = i * 500; at < durationMs; at += LEGIT_INTERVAL_MS) events.push({ at, clientId, path: "/api/resource" });
    return events;
  });
}

/** One event every `intervalMs` in [from, from + durationMs). */
function every(clientId: string, intervalMs: number, durationMs: number, from = 0): ScenarioEvent[] {
  const events: ScenarioEvent[] = [];
  for (let at = from; at < from + durationMs; at += intervalMs) events.push({ at, clientId, path: "/api/resource" });
  return events;
}

const burst = (clientId: string, at: number, n: number): ScenarioEvent[] =>
  Array.from({ length: n }, () => ({ at, clientId, path: "/api/resource" as const }));

export const byTime = (events: ScenarioEvent[]): ScenarioEvent[] => [...events].sort((a, b) => a.at - b.at);

/** Actual duration of a built round: the last event's offset. */
export const builtDurationMs = (events: ScenarioEvent[]): number => events.reduce((max, e) => Math.max(max, e.at), 0);

// ─── Rounds ─────────────────────────────────────────────────────────────────

const steadyFlood: Scenario = {
  id: 1,
  name: "Steady Flood",
  description: "One client hammers /api/resource at a constant high rate: 1 request every 50ms for 10s.",
  lesson: "Basic limiting. Any algorithm contains it.",
  clients: [legit.alice, legit.bob, attacker],
  durationMs: 10_000,
  build: () => byTime([...every("attacker", 50, 10_000), ...legitTraffic(["alice", "bob"], 10_000)]),
};

/**
 * A full quota just before a fixed-window boundary and another just after. Takes the first boundary at least
 * 500ms after the start, because setup logins may already have used part of a short window.
 */
const edgeExploit: Scenario = {
  id: 2,
  name: "Edge Exploit",
  description: "One client sends a full quota 400ms before a window boundary, then another 100ms after it.",
  lesson: "Fixed window's double-burst weakness: ~2× the limit gets through. Sliding and token don't allow it.",
  clients: [legit.alice, legit.bob, attacker],
  durationMs: 12_000,
  build: ({ config, windowEpochMs, startAt }) => {
    const k = Math.ceil((startAt + 500 - windowEpochMs) / config.windowMs);
    const boundary = windowEpochMs + k * config.windowMs;
    const before = boundary - 400 - startAt;
    const after = boundary + 100 - startAt;
    const duration = after + 2_000;
    return byTime([
      ...burst("attacker", before, config.maxRequests),
      ...burst("attacker", after, config.maxRequests),
      ...legitTraffic(["alice", "bob"], duration),
    ]);
  },
};

const burstAttack: Scenario = {
  id: 3,
  name: "Burst Attack",
  description: "One client sends 100 requests evenly over 5 seconds.",
  lesson: "Token bucket allows a controlled initial burst, then the refill rate. Sliding window is strict per window.",
  clients: [legit.alice, legit.bob, attacker],
  durationMs: 6_000,
  build: () => byTime([...every("attacker", 50, 5_000), ...legitTraffic(["alice", "bob"], 6_000)]),
};

const STUFFING_PASSWORD = "hunter2";

const credentialStuffing: Scenario = {
  id: 4,
  name: "Credential Stuffing + Forged Tokens",
  description:
    "60 wrong-password logins from one IP, forged-signature and alg:none tokens against /api/resource, " +
    "and a legitimate client holding an expired token.",
  lesson: "Login needs its own limit. Auth runs before the limiter, so forged tokens never touch anyone's budget.",
  clients: [
    legit.alice,
    legit.bob,
    { id: "carol", ip: "10.0.0.3", legit: true, auth: { type: "expired", username: "carol" } },
    { id: "stuffer", ip: ATTACKER_IP, legit: false, auth: { type: "none" } },
    // The forgers impersonate the legit users, to show it can't drain their budgets.
    { id: "forger", ip: "10.6.6.7", legit: false, auth: { type: "forged", sub: "alice" } },
    { id: "unsigned", ip: "10.6.6.8", legit: false, auth: { type: "algNone", sub: "bob" } },
  ],
  durationMs: 6_000,
  build: () => {
    const stuffing: ScenarioEvent[] = Array.from({ length: 60 }, (_, i) => ({
      at: i * 100,
      clientId: "stuffer",
      path: "/api/login",
      body: { username: POOL_USERS[i % POOL_USERS.length], password: STUFFING_PASSWORD },
    }));
    return byTime([
      ...stuffing,
      ...every("forger", 200, 6_000),
      ...every("unsigned", 200, 6_000, 100),
      ...legitTraffic(["alice", "bob", "carol"], 6_000),
    ]);
  },
};

const BOSS_REQUESTS_PER_ACCOUNT = 6;
const BOSS_DURATION_MS = 10_000;

const bossWave: Scenario = {
  id: 5,
  name: "Account-Rotation Boss Wave",
  description: "50 accounts log in from one IP and each sends 6 requests spread over 10s (~300 requests).",
  lesson: "Key by user and each account gets its own budget (~50× through). Key by IP and it's one budget.",
  clients: [
    legit.alice,
    legit.bob,
    legit.carol,
    ...POOL_USERS.map((username): ClientSpec => ({ id: username, ip: ATTACKER_IP, legit: false, auth: { type: "login", username } })),
  ],
  durationMs: BOSS_DURATION_MS,
  build: () => {
    const slot = BOSS_DURATION_MS / BOSS_REQUESTS_PER_ACCOUNT;
    const stagger = slot / POOL_USERS.length;
    const wave = POOL_USERS.flatMap((clientId, i) =>
      Array.from({ length: BOSS_REQUESTS_PER_ACCOUNT }, (_, j) => ({
        at: Math.round(j * slot + i * stagger),
        clientId,
        path: "/api/resource" as const,
      })),
    );
    return byTime([...wave, ...legitTraffic(["alice", "bob", "carol"], BOSS_DURATION_MS)]);
  },
};

export const SCENARIOS: readonly Scenario[] = Object.freeze([steadyFlood, edgeExploit, burstAttack, credentialStuffing, bossWave]);

export function getScenario(id: number): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new RangeError(`No round ${id}. Rounds are 1–${SCENARIOS.length}.`);
  return scenario;
}
