/**
 * JWT signing. Always HS256, with the secret from env. Payload is `{ sub, iat, exp }`, nothing sensitive,
 * since anyone can base64-decode a JWT payload.
 * (Verification lives here too from task 05.)
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
