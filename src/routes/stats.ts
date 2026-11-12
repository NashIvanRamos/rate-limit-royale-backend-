/**
 * GET /api/stats: the server's own tally for the current round (since the last deploy).
 * Never rate limited and never counted itself. In redis mode any node returns the whole cluster's numbers.
 */
import { Router } from "express";
import type { StatsBackend } from "../middleware/stats.js";
import type { RoundState } from "../state/round.js";
import { storeUnavailable, warnDegraded } from "../state/failure.js";

export function statsRouter(stats: StatsBackend, round: RoundState, nodeId: string): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    // Read the round at request time: a redeploy swaps the store for a fresh one.
    try {
      const view = await round.current();
      res.status(200).json({ nodeId, store: round.backend, limiterStore: view.config.limiterStore, ...(await stats.read(view)) });
    } catch (err) {
      warnDegraded("stats read failed", err);
      storeUnavailable(res, "store_unavailable");
    }
  });
  return router;
}
