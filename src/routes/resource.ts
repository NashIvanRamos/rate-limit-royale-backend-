/**
 * GET /api/resource: the protected endpoint under attack.
 *
 * Pipeline order matters (design doc §5):
 *   1. authenticate: invalid or missing token → 401 and STOP (the limiter is never touched)
 *   2. rateLimit:    key selection + limiter.allow() → 429 + Retry-After when denied
 *   3. handler:      200
 */
import { Router } from "express";
import type { DefenseState } from "../config/defense.js";
import { authenticate } from "../middleware/authenticate.js";
import { rateLimit } from "../middleware/rateLimit.js";

export function resourceRouter({ secret, defense, now }: { secret: string; defense: DefenseState; now: () => number }): Router {
  const router = Router();
  router.get("/", authenticate({ secret, now }), rateLimit(defense, now), (req, res) => {
    res.status(200).json({ ok: true, sub: req.auth!.sub, servedAt: now() });
  });
  return router;
}
