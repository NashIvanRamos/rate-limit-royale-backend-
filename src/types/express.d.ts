// Augments Express's Request with the verified JWT claims set by the auth middleware.
import type { LoginGuard } from "../auth/loginGuard.js";
import type { AuthFailureReason } from "../auth/jwt.js";
import type { DefenseState } from "../config/defense.js";
import type { StatsCollector } from "../middleware/stats.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { sub: string; exp: number };
    }
    interface Locals {
      defense: DefenseState;
      loginGuard: LoginGuard;
      stats: StatsCollector;
      /** Set by authenticate on a 401, read by the stats middleware. */
      authFailureReason?: AuthFailureReason;
      /** Set by rateLimit once a key is selected, read by the stats middleware. */
      rateLimitKey?: string;
    }
  }
}

export {};
