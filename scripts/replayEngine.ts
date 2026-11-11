/**
 * Node equivalent of the browser's round lifecycle (Frontend-Steps §3, §5):
 *
 *   1. Deploy  POST /api/defense (resets limiter, login lockouts and stats). Keep windowEpochMs.
 *   2. Setup   log in every `login` client, fetch expired tokens, forge attack tokens. Not tallied.
 *   3. Fire    each event at startAt + at, with the client's X-Forwarded-For and token.
 *   4. Drain   wait for everything, tally, score, then cross-check against GET /api/stats.
 *
 * Real clock: events fire concurrently on schedule (like setTimeout in the browser).
 * Fake clock (tests): events fire one at a time in time order, with the server clock set to each event's time.
 */
import type { DefenseConfig } from "../src/config/defense.js";
import type { StatsSnapshot } from "../src/middleware/stats.js";
import { attackProfile, score, tally, type Score, type Tally } from "../src/scenarios/results.js";
import type { ClientSpec, RequestRecord, Scenario, ScenarioEvent } from "../src/scenarios/types.js";
import type { Clock } from "./clock.js";
import { algNoneToken, forgedToken, MALFORMED_TOKEN } from "./day1Checks.js";

export interface ReplayOptions {
  baseUrl: string;
  scenario: Scenario;
  config: DefenseConfig;
  clock: Clock;
  /** Fire one request at a time in time order. Required with a fake clock. */
  sequential?: boolean;
  /** Gap between setup and the first event. Real clock only. */
  leadMs?: number;
}

export interface ClientSummary {
  ip: string;
  legit: boolean;
  sent: number;
  accepted: number;
  blocked: number;
  rejectedAuth: number;
}

export interface StatsCheck {
  matches: boolean;
  mismatches: string[];
}

export interface ReplayResult {
  scenario: { id: number; name: string };
  config: DefenseConfig;
  startAt: number;
  events: ScenarioEvent[];
  records: RequestRecord[];
  tally: Tally;
  score: Score;
  byClient: Record<string, ClientSummary>;
  /** Successful logins during setup. They show up in /api/stats but aren't tallied. */
  setupLogins: number;
  stats: StatsSnapshot;
  statsCheck: StatsCheck;
}

export class ReplayError extends Error {}

async function call(baseUrl: string, path: string, ip: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "X-Forwarded-For": ip,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => null)) as any;
  return { status: res.status, body };
}

/** Setup: one token (or none) per client. Logins run in parallel, each from the client's own IP. */
async function issueTokens(baseUrl: string, clients: readonly ClientSpec[], now: number) {
  const tokens = new Map<string, string>();
  let setupLogins = 0;
  await Promise.all(
    clients.map(async (c) => {
      switch (c.auth.type) {
        case "login": {
          const body = { username: c.auth.username, password: `pass-${c.auth.username}` };
          const res = await call(baseUrl, "/api/login", c.ip, { body });
          if (res.status !== 200) throw new ReplayError(`setup: login ${c.auth.username} from ${c.ip} → HTTP ${res.status}`);
          setupLogins++;
          tokens.set(c.id, res.body.token);
          break;
        }
        case "expired": {
          const body = { username: c.auth.username, password: `pass-${c.auth.username}` };
          const res = await call(baseUrl, "/api/demo/expired-token", c.ip, { body });
          if (res.status === 404) throw new ReplayError("setup: /api/demo/expired-token is 404. Start the server with DEMO_MODE=true");
          if (res.status !== 200) throw new ReplayError(`setup: expired token for ${c.auth.username} → HTTP ${res.status}`);
          tokens.set(c.id, res.body.token);
          break;
        }
        case "forged":
          tokens.set(c.id, forgedToken(c.auth.sub, now));
          break;
        case "algNone":
          tokens.set(c.id, algNoneToken(c.auth.sub, now));
          break;
        case "garbage":
          tokens.set(c.id, MALFORMED_TOKEN);
          break;
        case "none":
          break;
      }
    }),
  );
  return { tokens, setupLogins };
}

/** The server's tally must equal ours exactly. Setup logins are in the server's login counts, so add them. */
export function compareWithStats(records: readonly RequestRecord[], setupLogins: number, stats: StatsSnapshot): StatsCheck {
  const resource = records.filter((r) => r.path === "/api/resource");
  const login = records.filter((r) => r.path === "/api/login");
  const n = (rs: readonly RequestRecord[], status: number) => rs.filter((r) => r.status === status).length;
  const reasons = (reason: string) => resource.filter((r) => r.status === 401 && r.reason === reason).length;

  const pairs: [string, number, number][] = [
    ["resource.total", resource.length, stats.resource.total],
    ["resource.s200", n(resource, 200), stats.resource.s200],
    ["resource.s429", n(resource, 429), stats.resource.s429],
    ["resource.s401", n(resource, 401), stats.resource.s401],
    ...(["missing_token", "invalid_signature", "expired", "malformed"] as const).map(
      (reason): [string, number, number] => [`resource.byReason.${reason}`, reasons(reason), stats.resource.byReason[reason]],
    ),
    ["login.total", login.length + setupLogins, stats.login.total],
    ["login.s200", n(login, 200) + setupLogins, stats.login.s200],
    ["login.s401", n(login, 401), stats.login.s401],
    ["login.s429", n(login, 429), stats.login.s429],
  ];
  const mismatches = pairs.filter(([, ours, server]) => ours !== server).map(([k, ours, server]) => `${k}: replay ${ours}, server ${server}`);
  return { matches: mismatches.length === 0, mismatches };
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { baseUrl, scenario, config, clock } = opts;
  const clients = new Map(scenario.clients.map((c) => [c.id, c]));

  // 1. Deploy.
  const sentAt = Date.now();
  const deployed = await call(baseUrl, "/api/defense", "127.0.0.1", { body: config });
  if (deployed.status !== 200) throw new ReplayError(`deploy → HTTP ${deployed.status} ${JSON.stringify(deployed.body)}`);
  clock.calibrate?.(deployed.body.deployedAt, sentAt, Date.now());

  // 2. Setup.
  const { tokens, setupLogins } = await issueTokens(baseUrl, scenario.clients, clock.now());

  // 3. Fire.
  const startAt = clock.now() + (opts.leadMs ?? 0);
  const events = scenario.build({ config, windowEpochMs: deployed.body.windowEpochMs, startAt });
  for (const e of events) {
    if (!clients.has(e.clientId)) throw new ReplayError(`round ${scenario.id}: event for unknown client "${e.clientId}"`);
  }

  const fire = async (e: ScenarioEvent): Promise<RequestRecord> => {
    const client = clients.get(e.clientId)!;
    const t0 = performance.now();
    let status = 0;
    let reason: string | undefined;
    try {
      const res = await call(baseUrl, e.path, client.ip, {
        method: e.path === "/api/login" ? "POST" : "GET",
        body: e.body,
        token: tokens.get(client.id),
      });
      status = res.status;
      reason = res.body?.reason ?? res.body?.error;
    } catch {
      status = 0;
    }
    return { ...e, legit: client.legit, status, reason, latencyMs: performance.now() - t0 };
  };

  const records: RequestRecord[] = [];
  if (opts.sequential) {
    for (const e of events) {
      await clock.waitUntil(startAt + e.at);
      records.push(await fire(e));
    }
  } else {
    // Fire-and-forget on schedule. Never wait for one response before sending the next.
    const done = await Promise.all(
      events.map(async (e) => {
        await clock.waitUntil(startAt + e.at);
        return fire(e);
      }),
    );
    records.push(...done);
  }

  // 4. Drain, tally, cross-check.
  const t = tally(records);
  const byClient: Record<string, ClientSummary> = {};
  for (const r of records) {
    const c = clients.get(r.clientId)!;
    const s = (byClient[r.clientId] ??= { ip: c.ip, legit: c.legit, sent: 0, accepted: 0, blocked: 0, rejectedAuth: 0 });
    s.sent++;
    if (r.status === 200) s.accepted++;
    else if (r.status === 429) s.blocked++;
    else if (r.status === 401) s.rejectedAuth++;
  }

  const statsRes = await call(baseUrl, "/api/stats", "127.0.0.1");
  if (statsRes.status !== 200) throw new ReplayError(`GET /api/stats → HTTP ${statsRes.status}`);
  const stats = statsRes.body as StatsSnapshot;

  return {
    scenario: { id: scenario.id, name: scenario.name },
    config,
    startAt,
    events,
    records,
    tally: t,
    score: score(t, config, attackProfile(events, scenario.clients)),
    byClient,
    setupLogins,
    stats,
    statsCheck: compareWithStats(records, setupLogins, stats),
  };
}
