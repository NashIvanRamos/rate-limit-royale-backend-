/**
 * Rate-limit middleware: key selection, then the configured limiter.
 *
 * MUST be mounted after `authenticate`. Requests with invalid tokens are rejected there with a 401
 * and never reach this middleware, so they can't consume anyone's budget.
 *
 * Key selection:
 *   keyBy "user" and authenticated → `user:<sub>`
 *   otherwise                      → `ip:<client ip>`
 * Prefixes keep a username from colliding with an IP string.
 */
import type { Request, RequestHandler } from "express";
import type { DefenseConfig, DefenseState } from "../config/defense.js";
import { setRetryAfter } from "../http/retryAfter.js";
import { getClientKeyIp } from "./clientIp.js";

export function selectKey(req: Request, config: Pick<DefenseConfig, "keyBy">): string {
  if (config.keyBy === "user" && req.auth) return `user:${req.auth.sub}`;
  return `ip:${getClientKeyIp(req)}`;
}

export function rateLimit(state: DefenseState, now: () => number): RequestHandler {
  return (req, res, next) => {
    // Read config and limiter at request time, so a redeploy mid-round takes effect immediately.
    const { config, limiter } = state;
    const key = selectKey(req, config);
    // Read by the stats middleware (task 07) for the per-key breakdown.
    res.locals.rateLimitKey = key;
    const decision = limiter.allow(key, now());

    res.setHeader("RateLimit-Limit", String(config.maxRequests));
    res.setHeader("RateLimit-Remaining", String(decision.remaining));

    if (!decision.allowed) {
      setRetryAfter(res, decision.retryAfterMs);
      res.status(429).json({ error: "rate_limited", retryAfterMs: decision.retryAfterMs });
      return;
    }
    next();
  };
}
