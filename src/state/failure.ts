/**
 * What happens when the shared store (Redis) is unreachable (tasks2/06).
 *
 *   /api/resource  REDIS_FAILURE_MODE decides:
 *                    open   (default) → allow, with `X-RateLimit-Degraded: true`. Available, but unprotected.
 *                    closed           → 503 limiter_unavailable + Retry-After: 1. Protected, but down for everyone.
 *   /api/login     ALWAYS closed (503). An outage must not become an open door for credential stuffing.
 *   control plane  /api/defense and /api/stats → 503 store_unavailable. /api/health stays 200 and reports it.
 *
 * Failures are fast: Redis commands time out after REDIS_COMMAND_TIMEOUT_MS, so requests don't pile up.
 */
import type { Response } from "express";

export type FailureMode = "open" | "closed";

export function storeUnavailable(res: Response, error: "limiter_unavailable" | "store_unavailable"): void {
  res.setHeader("Retry-After", "1");
  res.status(503).json({ error });
}

let lastWarn = 0;
/** One warning per 5s at most, so an outage doesn't flood the logs. */
export function warnDegraded(what: string, err: unknown): void {
  const t = Date.now();
  if (t - lastWarn < 5_000) return;
  lastWarn = t;
  console.warn(`[degraded] ${what}: ${(err as Error)?.message ?? err}`);
}
