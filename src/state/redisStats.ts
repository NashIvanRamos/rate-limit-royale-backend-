/**
 * Stats in Redis (tasks2/03): every node adds to the same counters, so GET /api/stats on ANY node returns the whole
 * cluster's tally. Keys are namespaced by generation, so a deploy on one node starts fresh stats on all of them.
 *
 *   <prefix>stats:<gen>         hash   r.total, r.s200, r.s401, r.s429, r.other, r.reason.<reason>, l.total, l.s200, …
 *   <prefix>stats:<gen>:keys    zset   limiter key → requests
 *   <prefix>stats:<gen>:kv      hash   "<key>|a" allowed, "<key>|b" blocked
 *
 * Recording is fire-and-forget on `finish` (it never delays a response). Everything expires after a day.
 */
import type { RequestHandler } from "express";
import type { AuthFailureReason } from "../auth/jwt.js";
import { TOP_KEYS, type StatsBackend, type StatsSnapshot } from "../middleware/stats.js";
import { keyspace, type AppRedis } from "../redis/client.js";
import type { RoundView } from "./round.js";

const TTL_S = 24 * 60 * 60;
const REASONS: AuthFailureReason[] = ["missing_token", "invalid_signature", "expired", "malformed"];

function endpointOf(path: string): "resource" | "login" | null {
  const p = path.toLowerCase().replace(/\/+$/, "");
  return p === "/api/resource" ? "resource" : p === "/api/login" ? "login" : null;
}

const statusField = (status: number, known: number[]) => (known.includes(status) ? `s${status}` : "other");

export class RedisStats implements StatsBackend {
  private readonly key: ReturnType<typeof keyspace>;

  constructor(
    private readonly redis: AppRedis,
    prefix: string,
  ) {
    this.key = keyspace(prefix);
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      const endpoint = endpointOf(req.path);
      if (endpoint !== null) {
        res.on("finish", () => {
          const round: RoundView | undefined = res.locals.round;
          if (!round) return;
          this.record(endpoint, round.generation, res.statusCode, res.locals.authFailureReason, res.locals.rateLimitKey);
        });
      }
      next();
    };
  }

  private record(endpoint: "resource" | "login", gen: number, status: number, reason?: AuthFailureReason, key?: string) {
    const h = this.key("stats", gen);
    const p = this.redis.multi();
    if (endpoint === "login") {
      p.hincrby(h, "l.total", 1).hincrby(h, `l.${statusField(status, [200, 400, 401, 429])}`, 1);
    } else {
      p.hincrby(h, "r.total", 1).hincrby(h, `r.${statusField(status, [200, 401, 429])}`, 1);
      if (status === 401 && reason) p.hincrby(h, `r.reason.${reason}`, 1);
      if (key !== undefined && (status === 200 || status === 429)) {
        p.zincrby(this.key("stats", gen, "keys"), 1, key);
        p.hincrby(this.key("stats", gen, "kv"), `${key}|${status === 200 ? "a" : "b"}`, 1);
        p.expire(this.key("stats", gen, "keys"), TTL_S).expire(this.key("stats", gen, "kv"), TTL_S);
      }
    }
    p.expire(h, TTL_S);
    // Fire-and-forget: a stats write must never fail or delay a request.
    p.exec().catch(() => {});
  }

  async read(view: RoundView): Promise<StatsSnapshot> {
    const gen = view.generation;
    const [counts, top, trackedKeys] = await Promise.all([
      this.redis.hgetall(this.key("stats", gen)),
      this.redis.zrevrange(this.key("stats", gen, "keys"), 0, TOP_KEYS - 1, "WITHSCORES"),
      view.store.size(),
    ]);
    const n = (field: string) => Number(counts[field] ?? 0);

    const keys: string[] = [];
    for (let i = 0; i < top.length; i += 2) keys.push(top[i]!);
    const kv = keys.length ? await this.redis.hmget(this.key("stats", gen, "kv"), ...keys.flatMap((k) => [`${k}|a`, `${k}|b`])) : [];

    return {
      since: view.deployedAt,
      resource: {
        total: n("r.total"),
        s200: n("r.s200"),
        s401: n("r.s401"),
        s429: n("r.s429"),
        other: n("r.other"),
        byReason: Object.fromEntries(REASONS.map((r) => [r, n(`r.reason.${r}`)])) as StatsSnapshot["resource"]["byReason"],
      },
      login: { total: n("l.total"), s200: n("l.s200"), s400: n("l.s400"), s401: n("l.s401"), s429: n("l.s429"), other: n("l.other") },
      trackedKeys,
      topKeys: keys.map((key, i) => ({
        key,
        requests: Number(top[i * 2 + 1]),
        allowed: Number(kv[i * 2] ?? 0),
        blocked: Number(kv[i * 2 + 1] ?? 0),
      })),
      untrackedKeyRequests: 0,
    };
  }
}
