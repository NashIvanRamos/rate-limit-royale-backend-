/**
 * Server-side tally of responses, so the frontend's results card can be cross-checked against ground truth
 * ("the numbers come from the server", design doc §1, §11).
 *
 * Counts only /api/resource and /api/login, recorded on `res.on("finish")`, i.e. once the final status is
 * known. Health, defense, stats and demo helpers are never counted. Reset on every POST /api/defense, so each
 * round starts at zero.
 *
 * The server can't know which clients are "legitimate": that label lives in the frontend's scenario script,
 * so `legitBlocks` stays client-computed.
 *
 * Mount it BEFORE express.json(): a body-parser error skips ordinary middleware, so a tracker mounted later
 * would miss a login with malformed JSON.
 */
import type { RequestHandler } from "express";
import type { AuthFailureReason } from "../auth/jwt.js";

/** Per-key breakdown is bounded so a flood of distinct keys can't grow memory without limit. */
export const MAX_TRACKED_KEYS = 10_000;
export const TOP_KEYS = 10;

export interface ResourceCounts {
  total: number;
  s200: number;
  s401: number;
  s429: number;
  /** Anything else (404 for a wrong method, 5xx). Zero in normal play, so s200 + s401 + s429 === total. */
  other: number;
  byReason: Record<AuthFailureReason, number>;
}

export interface LoginCounts {
  total: number;
  s200: number;
  s400: number;
  s401: number;
  s429: number;
  other: number;
}

export interface KeyCounts {
  key: string;
  requests: number;
  allowed: number;
  blocked: number;
}

export interface StatsSnapshot {
  since: number;
  resource: ResourceCounts;
  login: LoginCounts;
  /** store.size() at read time: how many keys the active limiter store is holding. */
  trackedKeys: number;
  /** Top keys by requests that reached the limiter (200 or 429). 401s never reach it, so they have no key. */
  topKeys: KeyCounts[];
  /** Requests that reached the limiter after MAX_TRACKED_KEYS distinct keys were already tracked. */
  untrackedKeyRequests: number;
}

const emptyResource = (): ResourceCounts => ({
  total: 0,
  s200: 0,
  s401: 0,
  s429: 0,
  other: 0,
  byReason: { missing_token: 0, invalid_signature: 0, expired: 0, malformed: 0 },
});

const emptyLogin = (): LoginCounts => ({ total: 0, s200: 0, s400: 0, s401: 0, s429: 0, other: 0 });

type Endpoint = "resource" | "login";

/** Exact match on the two counted routes. Express routing is case-insensitive and ignores a trailing slash. */
function endpointOf(path: string): Endpoint | null {
  const p = path.toLowerCase().replace(/\/+$/, "");
  if (p === "/api/resource") return "resource";
  if (p === "/api/login") return "login";
  return null;
}

export class StatsCollector {
  private since: number;
  private resource = emptyResource();
  private login = emptyLogin();
  private keys = new Map<string, KeyCounts>();
  private untrackedKeyRequests = 0;
  /** Bumped on reset. A request that started before a deploy but finishes after it is not counted. */
  private generation = 0;

  constructor(now: number) {
    this.since = now;
  }

  reset(now: number): void {
    this.since = now;
    this.resource = emptyResource();
    this.login = emptyLogin();
    this.keys = new Map();
    this.untrackedKeyRequests = 0;
    this.generation++;
  }

  recordResource(status: number, reason?: AuthFailureReason, key?: string): void {
    const r = this.resource;
    r.total++;
    if (status === 200) r.s200++;
    else if (status === 401) {
      r.s401++;
      if (reason) r.byReason[reason]++;
    } else if (status === 429) r.s429++;
    else r.other++;

    if (key !== undefined && (status === 200 || status === 429)) this.recordKey(key, status === 200);
  }

  recordLogin(status: number): void {
    const l = this.login;
    l.total++;
    if (status === 200) l.s200++;
    else if (status === 400) l.s400++;
    else if (status === 401) l.s401++;
    else if (status === 429) l.s429++;
    else l.other++;
  }

  snapshot(trackedKeys: number): StatsSnapshot {
    const topKeys = [...this.keys.values()]
      .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
      .slice(0, TOP_KEYS)
      .map((k) => ({ ...k }));
    return {
      since: this.since,
      resource: { ...this.resource, byReason: { ...this.resource.byReason } },
      login: { ...this.login },
      trackedKeys,
      topKeys,
      untrackedKeyRequests: this.untrackedKeyRequests,
    };
  }

  /** Express middleware: counts each /api/resource and /api/login response when it finishes. */
  middleware(): RequestHandler {
    return (req, res, next) => {
      const endpoint = endpointOf(req.path);
      if (endpoint !== null) {
        const generation = this.generation;
        res.on("finish", () => {
          if (generation !== this.generation) return;
          if (endpoint === "login") this.recordLogin(res.statusCode);
          else this.recordResource(res.statusCode, res.locals.authFailureReason, res.locals.rateLimitKey);
        });
      }
      next();
    };
  }

  private recordKey(key: string, allowed: boolean): void {
    let entry = this.keys.get(key);
    if (!entry) {
      if (this.keys.size >= MAX_TRACKED_KEYS) {
        this.untrackedKeyRequests++;
        return;
      }
      entry = { key, requests: 0, allowed: 0, blocked: 0 };
      this.keys.set(key, entry);
    }
    entry.requests++;
    if (allowed) entry.allowed++;
    else entry.blocked++;
  }
}
