/**
 * POST /api/defense: deploy a new defense (resets all limiter state).
 * GET  /api/defense: current defense (preview panel, curl debugging).
 *
 * Unauthenticated by design for the local demo. In production this would be an admin-only control plane.
 * Never rate limited.
 */
import { Router } from "express";
import { validateDefenseConfig } from "../config/defense.js";
import { snapshotOf, type RoundState } from "../state/round.js";
import { storeUnavailable, warnDegraded } from "../state/failure.js";

export function defenseRouter(state: RoundState, now: () => number): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      res.status(200).json(snapshotOf(await state.current()));
    } catch (err) {
      warnDegraded("defense read failed", err);
      storeUnavailable(res, "store_unavailable");
    }
  });

  router.post("/", async (req, res) => {
    const result = validateDefenseConfig(req.body);
    if (!result.ok) {
      res.status(400).json({ error: "invalid_config", details: result.issues });
      return;
    }
    try {
      res.status(200).json(await state.deploy(result.config, now()));
    } catch (err) {
      warnDegraded("deploy failed", err);
      storeUnavailable(res, "store_unavailable");
    }
  });

  return router;
}
