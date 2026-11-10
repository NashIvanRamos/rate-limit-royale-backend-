/**
 * JWT signing and verification. Always HS256, with the secret from env. Payload is `{ sub, iat, exp }`,
 * nothing sensitive, since anyone can base64-decode a JWT payload.
 */
import jwt from "jsonwebtoken";

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const JWT_ALGORITHM = "HS256" as const;

const toSeconds = (ms: number) => Math.floor(ms / 1000);

/** Signs a 15-minute access token. `nowMs` is injectable so tests control iat/exp. */
export function signAccessToken(secret: string, sub: string, nowMs: number): string {
  const iat = toSeconds(nowMs);
  return jwt.sign({ sub, iat, exp: iat + ACCESS_TOKEN_TTL_S }, secret, { algorithm: JWT_ALGORITHM });
}

/**
 * Demo only: a correctly signed token that expired 60s ago, for the round 4 expired-token client.
 * The browser can't mint one itself because it never sees the secret.
 */
export function signExpiredToken(secret: string, sub: string, nowMs: number): string {
  const exp = toSeconds(nowMs) - 60;
  return jwt.sign({ sub, iat: exp - ACCESS_TOKEN_TTL_S, exp }, secret, { algorithm: JWT_ALGORITHM });
}

// ─── Verification ────────────────────────────────────────────────────────────

export type AuthFailureReason = "missing_token" | "invalid_signature" | "expired" | "malformed";

export interface AccessClaims {
  sub: string;
  exp: number;
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: Exclude<AuthFailureReason, "missing_token"> };

/** Tokens far larger than anything we issue are rejected before any parsing. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * Maps jsonwebtoken errors to our four public reasons. Checks the error class first, then the message.
 * Messages were verified against jsonwebtoken v9:
 *
 *   TokenExpiredError                   "jwt expired"               → expired
 *   JsonWebTokenError                   "invalid signature"         → invalid_signature (wrong secret / tampered)
 *   JsonWebTokenError                   "jwt signature is required" → invalid_signature (alg: none, empty sig)
 *   JsonWebTokenError                   "invalid algorithm"         → invalid_signature (alg: none + sig, HS512, RS256…)
 *   JsonWebTokenError                   "jwt malformed" / "invalid token" / "jwt must be provided" → malformed
 *   NotBeforeError                      "jwt not active"            → malformed (we never issue nbf)
 *   anything else                                                   → malformed (fail closed)
 *
 * jsonwebtoken checks the signature before exp, so a forged AND expired token reports invalid_signature.
 * A forger never learns "your token is merely expired".
 */
export function classifyJwtError(err: unknown): Exclude<AuthFailureReason, "missing_token"> {
  if (err instanceof jwt.TokenExpiredError) return "expired";
  if (err instanceof jwt.NotBeforeError) return "malformed";
  if (err instanceof jwt.JsonWebTokenError) {
    switch (err.message) {
      case "invalid signature":
      case "jwt signature is required":
      case "invalid algorithm":
        return "invalid_signature";
      default:
        return "malformed";
    }
  }
  return "malformed";
}

/**
 * Verifies an access token. `algorithms: ["HS256"]` is ALWAYS passed, so the `alg` header is never trusted:
 * `alg: none` and algorithm-confusion tokens are rejected. A valid signature isn't enough either: the
 * payload must be an object with a non-empty string `sub` and a numeric `exp`.
 */
export function verifyAccessToken(secret: string, token: string, nowMs: number): VerifyResult {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };

  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM], clockTimestamp: toSeconds(nowMs) });
  } catch (err) {
    return { ok: false, reason: classifyJwtError(err) };
  }

  if (typeof payload !== "object" || payload === null) return { ok: false, reason: "malformed" };
  const { sub, exp } = payload;
  if (typeof sub !== "string" || sub.length === 0 || typeof exp !== "number" || !Number.isFinite(exp)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, claims: { sub, exp } };
}
