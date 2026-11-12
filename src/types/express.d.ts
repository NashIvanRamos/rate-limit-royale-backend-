// Augments Express's Request and Locals (app.locals and res.locals share the Locals type).
import type { LoginGuard } from "../auth/loginGuard.js";
import type { AuthFailureReason } from "../auth/jwt.js";
import type { DefenseState } from "../config/defense.js";
import type { StatsBackend, StatsCollector } from "../middleware/stats.js";
import type { AppRedis } from "../redis/client.js";
import type { RoundState, RoundView } from "../state/round.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { sub: string; exp: number };
    }
    interface Locals {
      // ── app.locals: exposed for tests, not reachable over HTTP ──
      roundState: RoundState;
      statsBackend: StatsBackend;
      /** Memory mode only. */
      loginGuard: LoginGuard;
      /** Memory mode only (tests poke the in-process limiter through it). */
      defense: DefenseState;
      /** Memory mode only. */
      stats: StatsCollector;
      /** Redis mode only. Tests quit it on close. */
      redis?: AppRedis;

      // ── res.locals: per request ──
      /** The round this request runs against, loaded once by loadRound. */
      round?: RoundView;
      /** Set by authenticate on a 401, read by the stats middleware. */
      authFailureReason?: AuthFailureReason;
      /** Set by rateLimit once a key is selected, read by the stats middleware. */
      rateLimitKey?: string;
    }
  }
}

export {};
