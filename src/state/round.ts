/**
 * Round state: the deployed defense plus everything that resets with it (tasks2/03).
 *
 * Two backends behind one async interface:
 *   memory: per process (today's DefenseState). Correct on one node; behind a load balancer each node has its own.
 *   redis:  config + generation in Redis, so a deploy on any node applies to all of them (redisRound.ts).
 *
 * A request reads the round ONCE (`loadRound`), before anything else that depends on it, and the limiter, stats and
 * login guard all use that same snapshot. That keeps one request consistent even if a deploy lands mid-flight.
 */
import type { RequestHandler } from "express";
import type { LimiterStore } from "../algorithms/index.js";
import type { DefenseConfig, DefenseSnapshot, DefenseState, LimiterStoreKind } from "../config/defense.js";
import { warnDegraded } from "./failure.js";

export interface RoundView {
  /** Always carries the effective `limiterStore`. */
  config: Readonly<DefenseConfig & { limiterStore: LimiterStoreKind }>;
  deployedAt: number;
  /** Bumped on every deploy. Redis keys are namespaced by it, so a deploy "resets" without deleting anything. */
  generation: number;
  store: LimiterStore;
}

export interface RoundState {
  readonly backend: "memory" | "redis";
  /** Limiter stores a round may choose on this process (tasks2/09). */
  readonly limiterStores: readonly LimiterStoreKind[];
  current(): Promise<RoundView>;
  deploy(config: DefenseConfig, now: number): Promise<DefenseSnapshot>;
}

export const snapshotOf = (view: RoundView): DefenseSnapshot => ({
  config: { ...view.config },
  deployedAt: view.deployedAt,
  windowEpochMs: view.deployedAt,
});

/** Adapts the in-memory DefenseState (synchronous, unchanged) to RoundState. */
export class MemoryRoundState implements RoundState {
  readonly backend = "memory" as const;
  readonly limiterStores = ["memory"] as const;
  constructor(readonly defense: DefenseState) {}

  current(): Promise<RoundView> {
    const d = this.defense;
    const config = { ...d.config, limiterStore: "memory" as const };
    return Promise.resolve({ config, deployedAt: d.deployedAt, generation: d.generation, store: d.store });
  }

  deploy(config: DefenseConfig, now: number): Promise<DefenseSnapshot> {
    return Promise.resolve(this.defense.deploy(config, now));
  }
}

/** Paths whose handling depends on the round (limiter, login guard, stats). */
export function isRoundPath(path: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, "");
  return p === "/api/resource" || p === "/api/login" || p === "/api/demo/expired-token";
}

/**
 * Loads the round into `res.locals.round` for round paths. One Redis round-trip in redis mode, free in memory mode.
 * If the store is unreachable, the request continues with `res.locals.round` unset and `storeDown` set; the route
 * then applies the failure mode (tasks2/06) instead of crashing with a 500.
 */
export function loadRound(state: RoundState): RequestHandler {
  return async (req, res, next) => {
    if (isRoundPath(req.path)) {
      try {
        res.locals.round = await state.current();
      } catch (err) {
        res.locals.storeDown = true;
        warnDegraded("round state unavailable", err);
      }
    }
    next();
  };
}
