/**
 * Day 1 checks (design doc §10 Day 1, §12): the server returns the correct status for every case, for all
 * three algorithms. One implementation, two runners:
 *
 *   test/day1.test.ts  → in-process server, fake clock (deterministic and instant), plus one real-clock pass
 *   scripts/smoke.ts   → an already running server, real clock (the live demo / README table)
 *
 * Everything goes over HTTP, and tokens come from the server's own endpoints (login, demo expired-token),
 * so the checks never need the JWT secret. Forged tokens are signed with a random secret.
 */
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export const ALGORITHMS = ["fixed", "sliding", "token"] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

/** Deployed for every check: keyBy "user", 5 requests per 2s. */
export const DAY1 = Object.freeze({ maxRequests: 5, windowMs: 2_000, keyBy: "user" as const });

export const CASES = [
  { id: "1", name: "No token → 401 missing_token" },
  { id: "2", name: "Forged signature → 401 invalid_signature, limiter untouched" },
  { id: "3", name: "alg: none → 401 invalid_signature" },
  { id: "4", name: "Expired token → 401 expired" },
  { id: "5", name: "Malformed token → 401 malformed" },
  { id: "6", name: "Valid × 5 → 200 × 5, then 429 + Retry-After" },
  { id: "7", name: "After waiting retryAfterMs → 200" },
  { id: "8", name: "Algorithm behaviour (edge burst / refill)" },
] as const;
export type CaseId = (typeof CASES)[number]["id"];

export const ALGORITHM_CHECK: Record<Algorithm, string> = {
  fixed: "5 just before + 5 just after a boundary → 10 × 200 (edge double burst)",
  sliding: "5 just before + 5 just after a boundary → only 5 × 200",
  token: "5 instant → 200, 6th → 429, after windowMs/5 → exactly 1 more 200",
};

export interface CheckResult {
  id: CaseId;
  algorithm: Algorithm;
  pass: boolean;
  detail: string;
}

/**
 * The checks' view of time. "Server time" is what the server's limiter sees.
 * Real clock: Date.now() plus an offset calibrated from the deploy response. Fake clock: the test's clock.
 */
export interface Clock {
  now(): number;
  waitUntil(serverTimeMs: number): Promise<void>;
  /** Added to every wait. Absorbs network latency on a real clock, 0 on a fake one. */
  readonly slackMs: number;
  calibrate?(serverTimeMs: number, sentAtMs: number, receivedAtMs: number): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function realClock(slackMs = 30): Clock {
  let offset = 0;
  return {
    slackMs,
    now: () => Date.now() + offset,
    async waitUntil(t) {
      const delay = t - (Date.now() + offset);
      if (delay > 0) await sleep(delay);
    },
    calibrate(serverTime, sentAt, receivedAt) {
      offset = serverTime - (sentAt + receivedAt) / 2;
    },
  };
}

// ─── HTTP client ────────────────────────────────────────────────────────────

interface ResourceResult {
  status: number;
  reason?: string;
  retryAfterMs?: number;
  retryAfterHeader: string | null;
}

interface StatsBody {
  trackedKeys: number;
}

class Day1Client {
  constructor(
    private readonly baseUrl: string,
    private readonly clock: Clock,
    /** Simulated client IP for every request (ignored by the server unless it trusts the proxy). */
    private readonly ip = "10.0.0.200",
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: any }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "X-Forwarded-For": this.ip, ...(init.headers as Record<string, string>) },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  private post(path: string, payload: unknown) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** Deploys the Day 1 config and returns the fixed-window epoch. Also calibrates a real clock. */
  async deploy(algorithm: Algorithm): Promise<number> {
    const sentAt = Date.now();
    const res = await this.post("/api/defense", { algorithm, ...DAY1 });
    const receivedAt = Date.now();
    if (res.status !== 200) throw new Error(`deploy ${algorithm} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    this.clock.calibrate?.(res.body.deployedAt, sentAt, receivedAt);
    return res.body.windowEpochMs;
  }

  async login(username: string, password: string): Promise<string> {
    const res = await this.post("/api/login", { username, password });
    if (res.status !== 200) throw new Error(`login ${username} failed: HTTP ${res.status}`);
    return res.body.token;
  }

  /** null when the endpoint is off (DEMO_MODE=false). */
  async expiredToken(username: string, password: string): Promise<string | null> {
    const res = await this.post("/api/demo/expired-token", { username, password });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`expired-token failed: HTTP ${res.status}`);
    return res.body.token;
  }

  async resource(token: string | null): Promise<ResourceResult> {
    const res = await this.request("/api/resource", token === null ? {} : { headers: { Authorization: `Bearer ${token}` } });
    return {
      status: res.status,
      reason: res.body?.reason,
      retryAfterMs: res.body?.retryAfterMs,
      retryAfterHeader: res.headers.get("retry-after"),
    };
  }

  async burst(token: string, n: number): Promise<number[]> {
    const results = await Promise.all(Array.from({ length: n }, () => this.resource(token)));
    return results.map((r) => r.status);
  }

  /** Limiter key count, from GET /api/stats (task 07). */
  async trackedKeys(): Promise<number | null> {
    const res = await this.request("/api/stats");
    return res.status === 200 ? (res.body as StatsBody).trackedKeys : null;
  }
}

// ─── Token forgery (attacker side, no secret needed) ────────────────────────

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function claims(sub: string, nowMs: number) {
  const iat = Math.floor(nowMs / 1000);
  return { sub, iat, exp: iat + 900 };
}

/** Well-formed and unexpired, but signed with a secret the server doesn't know. */
export function forgedToken(sub: string, nowMs: number): string {
  return jwt.sign(claims(sub, nowMs), randomBytes(48).toString("base64url"), { algorithm: "HS256" });
}

/** `alg: none`, empty signature segment. */
export function algNoneToken(sub: string, nowMs: number): string {
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims(sub, nowMs))}.`;
}

export const MALFORMED_TOKEN = "a.b.c";

// ─── Checks ─────────────────────────────────────────────────────────────────

const count = (statuses: number[], code: number) => statuses.filter((s) => s === code).length;
const summarize = (statuses: number[]) => `[${statuses.join(", ")}]`;

function expect401(res: ResourceResult, reason: string): { pass: boolean; detail: string } {
  const pass = res.status === 401 && res.reason === reason;
  return { pass, detail: `HTTP ${res.status}${res.reason ? ` ${res.reason}` : ""} (expected 401 ${reason})` };
}

export interface RunOptions {
  baseUrl: string;
  clock: Clock;
  /** Demo user credentials. Defaults to the seeded "alice". */
  username?: string;
  password?: string;
}

/** Runs cases 1–8 for one algorithm. Never throws for a failed check, only for an unreachable server. */
export async function runDay1(algorithm: Algorithm, opts: RunOptions): Promise<CheckResult[]> {
  const { clock } = opts;
  const username = opts.username ?? "alice";
  const password = opts.password ?? `pass-${username}`;
  const client = new Day1Client(opts.baseUrl, clock);
  const results: CheckResult[] = [];
  const record = (id: CaseId, pass: boolean, detail: string) => results.push({ id, algorithm, pass, detail });

  // ── Cases 1–7: one fresh deploy. The 401 cases run first, so case 6 also proves they didn't drain the budget.
  await client.deploy(algorithm);
  const token = await client.login(username, password);
  const expired = await client.expiredToken(username, password);

  let r = expect401(await client.resource(null), "missing_token");
  record("1", r.pass, r.detail);

  const forged = await client.resource(forgedToken(username, clock.now()));
  r = expect401(forged, "invalid_signature");
  const keys = await client.trackedKeys();
  if (keys === null) record("2", false, `${r.detail}; GET /api/stats unavailable, can't verify the limiter`);
  else record("2", r.pass && keys === 0, `${r.detail}; limiter keys after = ${keys} (expected 0)`);

  r = expect401(await client.resource(algNoneToken(username, clock.now())), "invalid_signature");
  record("3", r.pass, r.detail);

  if (expired === null) {
    record("4", false, "POST /api/demo/expired-token is 404: start the server with DEMO_MODE=true");
  } else {
    r = expect401(await client.resource(expired), "expired");
    record("4", r.pass, r.detail);
  }

  r = expect401(await client.resource(MALFORMED_TOKEN), "malformed");
  record("5", r.pass, r.detail);

  const firstFive: number[] = [];
  for (let i = 0; i < DAY1.maxRequests; i++) firstFive.push((await client.resource(token)).status);
  const sixth = await client.resource(token);
  const blockedAt = clock.now();
  const retryMs = sixth.retryAfterMs ?? 0;
  const headerOk = sixth.retryAfterHeader === String(Math.max(1, Math.ceil(retryMs / 1000)));
  record(
    "6",
    count(firstFive, 200) === DAY1.maxRequests && sixth.status === 429 && retryMs > 0 && headerOk,
    `${summarize(firstFive)} then ${sixth.status}, retryAfterMs=${sixth.retryAfterMs}, Retry-After=${sixth.retryAfterHeader}`,
  );

  if (sixth.status !== 429 || retryMs <= 0) {
    record("7", false, "skipped: case 6 did not produce a 429 with retryAfterMs");
  } else {
    await clock.waitUntil(blockedAt + retryMs + clock.slackMs);
    const again = await client.resource(token);
    record("7", again.status === 200, `waited ${retryMs}ms → HTTP ${again.status} (expected 200)`);
  }

  // ── Case 8: algorithm-specific behaviour, on a fresh deploy.
  if (algorithm === "token") {
    await client.deploy(algorithm);
    const t = await client.login(username, password);
    const burst = await client.burst(t, DAY1.maxRequests);
    const blocked = await client.resource(t);
    await clock.waitUntil(clock.now() + DAY1.windowMs / DAY1.maxRequests + clock.slackMs);
    const refilled = await client.resource(t);
    const after = await client.resource(t);
    record(
      "8",
      count(burst, 200) === DAY1.maxRequests && blocked.status === 429 && refilled.status === 200 && after.status === 429,
      `burst ${summarize(burst)}, 6th ${blocked.status}, after ${DAY1.windowMs / DAY1.maxRequests}ms ${refilled.status} then ${after.status} (expected 429, 200, 429)`,
    );
  } else {
    const epoch = await client.deploy(algorithm);
    const t = await client.login(username, password);
    const boundary = epoch + DAY1.windowMs;
    await clock.waitUntil(boundary - 300);
    const before = await client.burst(t, DAY1.maxRequests);
    await clock.waitUntil(boundary + 50 + clock.slackMs);
    const afterB = await client.burst(t, DAY1.maxRequests);
    const all = [...before, ...afterB];
    const expected200 = algorithm === "fixed" ? 2 * DAY1.maxRequests : DAY1.maxRequests;
    record(
      "8",
      count(all, 200) === expected200 && count(all, 429) === all.length - expected200,
      `before boundary ${summarize(before)}, after ${summarize(afterB)} → ${count(all, 200)} × 200 (expected ${expected200})`,
    );
  }

  return results;
}
