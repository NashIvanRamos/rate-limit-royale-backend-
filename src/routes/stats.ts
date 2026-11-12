/**
 * GET /api/stats: the server's own tally for the current round (since the last deploy).
 * Never rate limited and never counted itself.
 */
import { Router } from "express";
import type { DefenseState } from "../config/defense.js";
import type { StatsCollector } from "../middleware/stats.js";

export function statsRouter(stats: StatsCollector, defense: DefenseState): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    // Read the limiter at request time: a redeploy swaps it for a fresh one.
    res.status(200).json(stats.snapshot(defense.limiter.size()));
  });
  return router;
}
