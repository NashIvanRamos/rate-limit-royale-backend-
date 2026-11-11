/**
 * Tally and reference scoring (design doc §6 tally, §8 scoring). Scoring stays frontend-side. This is the
 * tested reference so the formula only has to be checked once, then copied.
 *
 * 401s are NEVER legitimate blocks: a legit client with an expired token is a client error, not a defense
 * failure. It's reported as `legitExpired` and costs nothing.
 */
import type { DefenseConfig } from "../config/defense.js";
import type { ClientSpec, RequestRecord, ScenarioEvent } from "./types.js";

export interface Tally {
  total: number;
  /** 200 */
  accepted: number;
  /** 429 */
  blocked: number;
  /** 401 */
  rejectedAuth: number;
  /** status 0: network error or aborted. Never counted as accepted or blocked. */
  errors: number;
  /** Anything else (for example 400). Zero in normal play. */
  other: number;
  avgLatencyMs: number;
  /** Legit client got a 429. The only thing that costs XP. */
  legitBlocks: number;
  /** Legit client got a 401 (round 4's expired token). Reported separately, costs nothing. */
  legitExpired: number;
  attackTotal: number;
  /** Attacker got a 429 or a 401. */
  attackStopped: number;
  /** Attacker got a 200. */
  attackPassed: number;
}

export function tally(records: readonly RequestRecord[]): Tally {
  const t: Tally = {
    total: records.length,
    accepted: 0,
    blocked: 0,
    rejectedAuth: 0,
    errors: 0,
    other: 0,
    avgLatencyMs: 0,
    legitBlocks: 0,
    legitExpired: 0,
    attackTotal: 0,
    attackStopped: 0,
    attackPassed: 0,
  };
  let latency = 0;
  for (const r of records) {
    latency += r.latencyMs;
    if (r.status === 200) t.accepted++;
    else if (r.status === 429) t.blocked++;
    else if (r.status === 401) t.rejectedAuth++;
    else if (r.status === 0) t.errors++;
    else t.other++;

    if (r.legit) {
      if (r.status === 429) t.legitBlocks++;
      else if (r.status === 401) t.legitExpired++;
    } else {
      t.attackTotal++;
      if (r.status === 200) t.attackPassed++;
      else if (r.status === 429 || r.status === 401) t.attackStopped++;
    }
  }
  t.avgLatencyMs = records.length === 0 ? 0 : latency / records.length;
  return t;
}

export interface AttackProfile {
  /** First to last attacker event. */
  attackDurationMs: number;
  /** Distinct IPs that sent attack traffic. */
  attackerIpCount: number;
}

export function attackProfile(events: readonly ScenarioEvent[], clients: readonly ClientSpec[]): AttackProfile {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const attack = events.filter((e) => byId.get(e.clientId)?.legit === false);
  if (attack.length === 0) return { attackDurationMs: 0, attackerIpCount: 0 };
  const times = attack.map((e) => e.at);
  return {
    attackDurationMs: Math.max(...times) - Math.min(...times),
    attackerIpCount: new Set(attack.map((e) => byId.get(e.clientId)!.ip)).size,
  };
}

export interface Score {
  /** What a fair per-IP defense lets through: one full quota (the burst) plus the sustained rate. */
  allowance: number;
  /** 1 when attack traffic stayed within allowance × TOLERANCE, otherwise proportionally less. */
  containment: number;
  legitPenalty: number;
  xpEarned: number;
  cleared: boolean;
}

export const MAX_XP = 500;
/** Slack over the allowance before containment starts dropping (timing jitter, a request landing late). */
export const TOLERANCE = 1.15;
export const PENALTY_PER_LEGIT_BLOCK = 0.1;
export const CLEAR_CONTAINMENT = 0.8;

/**
 * XP = 500 × containment × (1 − legitPenalty). Cleared = zero legit blocks and containment ≥ 0.8.
 *
 * allowance = maxRequests × (1 + attackDurationMs / windowMs) × attackerIpCount
 *
 * i.e. one full quota up front plus the configured rate for the attack's duration. That is exactly what a token
 * bucket admits and the most a sliding window admits, so every well-configured algorithm can clear rounds
 * 1, 3 and 4. Frontend-Steps §6 originally used `floor(duration / windowMs) + 1` windows. That gives the
 * token bucket no credit for refill, so it failed round 1 at ~0.6 containment while blocking 90% of the flood.
 *
 * Round 2 still fails on a fixed window: the attack lasts 500ms, so the allowance is ~1.05 × max, and the double
 * burst lets 2 × max through (containment ≈ 0.58).
 */
export function score(t: Tally, config: Pick<DefenseConfig, "maxRequests" | "windowMs">, profile: AttackProfile): Score {
  const allowance = config.maxRequests * (1 + profile.attackDurationMs / config.windowMs) * profile.attackerIpCount;
  const budget = allowance * TOLERANCE;
  const containment = t.attackPassed <= budget ? 1 : budget / Math.max(1, t.attackPassed);
  const legitPenalty = Math.min(1, t.legitBlocks * PENALTY_PER_LEGIT_BLOCK);
  return {
    allowance,
    containment,
    legitPenalty,
    xpEarned: Math.round(MAX_XP * containment * (1 - legitPenalty)),
    cleared: t.legitBlocks === 0 && containment >= CLEAR_CONTAINMENT,
  };
}
