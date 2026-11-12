/**
 * POST /api/login               → 15-minute access token
 * POST /api/demo/expired-token  → already-expired token (mounted only when DEMO_MODE=true)
 *
 * Both share one flow and one IP-keyed failure limiter:
 *   1. IP over the failure budget → 429 + Retry-After. Credentials are NOT checked, so stuffing stops being useful.
 *   2. Malformed body → 400 (not counted as a failure).
 *   3. Wrong username or password → 401 invalid_credentials (same response for both), failure recorded.
 *   4. Success → 200, nothing recorded.
 */
import { Router, type Request, type Response } from "express";
import { ACCESS_TOKEN_TTL_S, signAccessToken, signExpiredToken } from "../auth/jwt.js";
import type { LoginGuardBackend } from "../auth/loginGuard.js";
import { verifyCredentials } from "../config/users.js";
import { setRetryAfter } from "../http/retryAfter.js";
import { getClientKeyIp } from "../middleware/clientIp.js";
import { storeUnavailable, warnDegraded } from "../state/failure.js";

const MAX_USERNAME = 64;
const MAX_PASSWORD = 128;

interface Credentials {
  username: string;
  password: string;
}

function parseCredentials(body: unknown): Credentials | null {
  if (typeof body !== "object" || body === null) return null;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  if (username.length === 0 || username.length > MAX_USERNAME) return null;
  if (password.length === 0 || password.length > MAX_PASSWORD) return null;
  return { username, password };
}

interface LoginDeps {
  secret: string;
  guard: LoginGuardBackend;
  now: () => number;
}

type Issue = (secret: string, sub: string, nowMs: number) => string;

function loginHandler({ secret, guard, now }: LoginDeps, issue: Issue, extra: (sub: string) => object) {
  return async (req: Request, res: Response) => {
    const t = now();
    const ip = getClientKeyIp(req);
    // Login always fails closed when the store is down: no lockout state means no brute-force protection.
    const round = res.locals.round;
    if (!round) return storeUnavailable(res, "store_unavailable");
    const generation = round.generation;

    let gate;
    try {
      gate = await guard.check(ip, t, generation, round.config.limiterStore);
    } catch (err) {
      warnDegraded("login guard unavailable", err);
      return storeUnavailable(res, "store_unavailable");
    }
    if (!gate.allowed) {
      setRetryAfter(res, gate.retryAfterMs);
      res.status(429).json({ error: "rate_limited", retryAfterMs: gate.retryAfterMs });
      return;
    }

    const creds = parseCredentials(req.body);
    if (!creds) {
      res.status(400).json({ error: "bad_request" });
      return;
    }

    if (!verifyCredentials(creds.username, creds.password)) {
      // Awaited, so the lockout is in place before the attacker sees this response and tries again.
      try {
        await guard.recordFailure(ip, t, generation, round.config.limiterStore);
      } catch (err) {
        warnDegraded("login guard unavailable", err);
        return storeUnavailable(res, "store_unavailable");
      }
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const sub = creds.username;
    res.status(200).json({ token: issue(secret, sub, t), tokenType: "Bearer", sub, ...extra(sub) });
  };
}

export function loginRouter(deps: LoginDeps): Router {
  const router = Router();
  router.post("/", loginHandler(deps, signAccessToken, () => ({ expiresIn: ACCESS_TOKEN_TTL_S })));
  return router;
}

export function expiredTokenRouter(deps: LoginDeps): Router {
  const router = Router();
  router.post("/", loginHandler(deps, signExpiredToken, () => ({ expired: true })));
  return router;
}
