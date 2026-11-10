/**
 * POST /api/defense: deploy a new defense (resets all limiter state).
 * GET  /api/defense: current defense (preview panel, curl debugging).
 *
 * Unauthenticated by design for the local demo. In production this would be an admin-only control plane.
 * Never rate limited.
 */
import { Router } from "express";
import { validateDefenseConfig, type DefenseState } from "../config/defense.js";

export function defenseRouter(state: DefenseState, now: () => number): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.status(200).json(state.snapshot());
  });

  router.post("/", (req, res) => {
    const result = validateDefenseConfig(req.body);
    if (!result.ok) {
      res.status(400).json({ error: "invalid_config", details: result.issues });
      return;
    }
    res.status(200).json(state.deploy(result.config, now()));
  });

  return router;
}
