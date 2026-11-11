/**
 * Shared scenario shape (design doc §6–7, Frontend-Steps §4). The frontend's scenarios.js mirrors these
 * types. The backend uses them for replays (scripts/replay.ts) and the per-round tests.
 *
 * Scenarios are functions of the deployed config, not static arrays: round 2 aims at the real window
 * boundary, and attackers "know" the limit (a real attacker reads RateLimit-Limit).
 */
import type { DefenseConfig } from "../config/defense.js";

/**
 * How a client authenticates to /api/resource.
 *   login    → logs in during setup and sends a valid token
 *   expired  → gets a correctly signed, already-expired token from POST /api/demo/expired-token
 *   forged   → token claiming `sub`, signed with a secret the server doesn't know
 *   algNone  → unsigned `alg: none` token claiming `sub`
 *   garbage  → not a JWT at all ("a.b.c")
 *   none     → no Authorization header (and the only option for login-only clients)
 */
export type ClientAuth =
  | { type: "none" }
  | { type: "login"; username: string }
  | { type: "expired"; username: string }
  | { type: "forged"; sub: string }
  | { type: "algNone"; sub: string }
  | { type: "garbage" };

export interface ClientSpec {
  id: string;
  /** Simulated client IP, sent as X-Forwarded-For. */
  ip: string;
  legit: boolean;
  auth: ClientAuth;
}

export type ScenarioPath = "/api/resource" | "/api/login";

export interface ScenarioEvent {
  /** Milliseconds after the round's start. */
  at: number;
  clientId: string;
  path: ScenarioPath;
  /** JSON body, for /api/login events. */
  body?: unknown;
}

export interface ScenarioContext {
  config: DefenseConfig;
  /** From the deploy response. Fixed-window boundaries are at windowEpochMs + k × windowMs (server time). */
  windowEpochMs: number;
  /** Server time when firing begins. Event `at` offsets are relative to this. */
  startAt: number;
}

export interface Scenario {
  id: 1 | 2 | 3 | 4 | 5;
  name: string;
  description: string;
  lesson: string;
  clients: ClientSpec[];
  /** Nominal duration for the briefing tile. build() may extend it (round 2 waits for a boundary). */
  durationMs: number;
  build(ctx: ScenarioContext): ScenarioEvent[];
}

/** One fired request and its outcome. status 0 = network error or aborted. */
export interface RequestRecord extends ScenarioEvent {
  legit: boolean;
  status: number;
  /** `reason` for a 401 from /api/resource, otherwise the body's `error`. */
  reason?: string;
  latencyMs: number;
}
