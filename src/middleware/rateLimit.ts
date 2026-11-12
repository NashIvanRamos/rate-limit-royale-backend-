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
import type { DefenseConfig } from "../config/defense.js";
import { setRetryAfter } from "../http/retryAfter.js";
import { getClientKeyIp } from "./clientIp.js";

export function selectKey(req: Request, config: Pick<DefenseConfig, "keyBy">): string {
  if (config.keyBy === "user" && req.auth) return `user:${req.auth.sub}`;
  return `ip:${getClientKeyIp(req)}`;
}

export function rateLimit(now: () => number): RequestHandler {
  // Async because the store may be remote (tasks2). Express 5 forwards a rejected promise to the error handler.
  return async (req, res, next) => {
    // The round loaded for this request (loadRound), so a redeploy takes effect on the next request.
    const { config, store } = res.locals.round!;
    const key = selectKey(req, config);
    // Read by the stats middleware (task 07) for the per-key breakdown.
    res.locals.rateLimitKey = key;
    const decision = await store.allow(key, now());

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
