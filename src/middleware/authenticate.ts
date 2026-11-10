/**
 * Bearer JWT authentication.
 *
 * Success → `req.auth = { sub, exp }`, then next().
 * Failure → 401 `{ error: "unauthorized", reason }`, where reason is one of
 *           missing_token | invalid_signature | expired | malformed.
 *
 * Deliberately has NO knowledge of the rate limiter. It runs first in the pipeline, so a 401 returns
 * before any limiter is touched and forged or expired tokens can't drain a legitimate client's budget.
 */
import type { RequestHandler, Response } from "express";
import { verifyAccessToken, type AuthFailureReason } from "../auth/jwt.js";

const REALM = "rate-limit-royale";

/**
 * Extracts the token from `Authorization: Bearer <token>`. The scheme is case-insensitive (RFC 6750).
 * Returns null when the header is missing, uses another scheme, or carries no token.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  return match ? match[1]! : null;
}

function unauthorized(res: Response, reason: AuthFailureReason): void {
  // RFC 6750 §3: no error code when credentials are absent, error="invalid_token" otherwise.
  res.setHeader(
    "WWW-Authenticate",
    reason === "missing_token"
      ? `Bearer realm="${REALM}"`
      : `Bearer realm="${REALM}", error="invalid_token", error_description="${reason}"`,
  );
  res.status(401).json({ error: "unauthorized", reason });
}

export function authenticate({ secret, now }: { secret: string; now: () => number }): RequestHandler {
  return (req, res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (token === null) {
      unauthorized(res, "missing_token");
      return;
    }

    const result = verifyAccessToken(secret, token, now());
    if (!result.ok) {
      unauthorized(res, result.reason);
      return;
    }

    req.auth = result.claims;
    next();
  };
}
