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
import { storeUnavailable, warnDegraded, type FailureMode } from "../state/failure.js";

export function selectKey(req: Request, config: Pick<DefenseConfig, "keyBy">): string {
  if (config.keyBy === "user" && req.auth) return `user:${req.auth.sub}`;
  return `ip:${getClientKeyIp(req)}`;
}

export function rateLimit(now: () => number, failureMode: FailureMode = "open"): RequestHandler {
  // Async because the store may be remote (tasks2).
  return async (req, res, next) => {
    // The store is unreachable: apply the failure mode rather than erroring (tasks2/06).
    const degrade = (err?: unknown) => {
      if (err !== undefined) warnDegraded("limiter store unavailable", err);
      if (failureMode === "closed") return storeUnavailable(res, "limiter_unavailable");
      res.setHeader("X-RateLimit-Degraded", "true");
      next();
    };

    // The round loaded for this request (loadRound), so a redeploy takes effect on the next request.
    const round = res.locals.round;
    if (!round) return degrade();
    const { config, store } = round;
    const key = selectKey(req, config);
    // Read by the stats middleware (task 07) for the per-key breakdown.
    res.locals.rateLimitKey = key;
    let decision;
    try {
      decision = await store.allow(key, now());
    } catch (err) {
      return degrade(err);
    }

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
