/**
 * Hand-built attack tokens, reused by the auth, pipeline (task 06) and scenario (task 09) tests.
 * All take `nowMs` so they work with a fake clock.
 */
import jwt from "jsonwebtoken";
import { TEST_SECRET } from "./server.js";

const WRONG_SECRET = "attacker-guessed-secret-that-is-long-enough!!";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const s = (ms: number) => Math.floor(ms / 1000);

export function validToken(sub: string, nowMs: number, secret = TEST_SECRET): string {
  const iat = s(nowMs);
  return jwt.sign({ sub, iat, exp: iat + 900 }, secret, { algorithm: "HS256" });
}

/** Correct structure, signed with the wrong secret. */
export function forgeSignature(sub: string, nowMs: number): string {
  return validToken(sub, nowMs, WRONG_SECRET);
}

/** Unsigned token: `alg: none` with an empty signature segment. */
export function algNone(sub: string, nowMs: number): string {
  const iat = s(nowMs);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub, iat, exp: iat + 900 })}.`;
}

/** `alg: none` header, but a real signature segment copied from a valid token. */
export function algNoneWithSignature(sub: string, nowMs: number): string {
  const sig = validToken(sub, nowMs).split(".")[2];
  const iat = s(nowMs);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub, iat, exp: iat + 900 })}.${sig}`;
}

/** Algorithm switch: same secret, but HS512. Must still be rejected because only HS256 is allowed. */
export function wrongAlgorithm(sub: string, nowMs: number): string {
  const iat = s(nowMs);
  return jwt.sign({ sub, iat, exp: iat + 900 }, TEST_SECRET, { algorithm: "HS512" });
}

/** Takes a valid token and swaps the payload's `sub`, keeping the original signature. */
export function tamperPayload(token: string, newSub: string): string {
  const [header, payload, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  return `${header}.${b64({ ...claims, sub: newSub })}.${sig}`;
}

/** Correctly signed, but `exp` is in the past. */
export function expired(sub: string, nowMs: number): string {
  const exp = s(nowMs) - 60;
  return jwt.sign({ sub, iat: exp - 900, exp }, TEST_SECRET, { algorithm: "HS256" });
}

/** Expired AND forged. Must report invalid_signature, never expired. */
export function expiredForged(sub: string, nowMs: number): string {
  const exp = s(nowMs) - 60;
  return jwt.sign({ sub, iat: exp - 900, exp }, WRONG_SECRET, { algorithm: "HS256" });
}

/** Correctly signed but with an unusable payload shape. */
export function signedPayload(payload: string | object, nowMs: number): string {
  if (typeof payload === "string") return jwt.sign(payload, TEST_SECRET, { algorithm: "HS256" });
  return jwt.sign({ iat: s(nowMs), ...payload }, TEST_SECRET, { algorithm: "HS256" });
}

export const GARBAGE_TOKENS = ["abc", "a.b.c", "eyJ.eyJ", "....", "%%%.%%%.%%%"];
