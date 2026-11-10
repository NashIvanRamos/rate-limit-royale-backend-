/**
 * In-memory demo users. No database and no password hashing: both are out of scope (design doc §1).
 *
 * - LEGIT_USERS: legitimate clients present in every round.
 * - POOL_USERS:  user01..user50, the attacker's account pool (round 5 rotation, round 4 stuffing targets).
 * Keeping them disjoint means a legitimate identity is never shared with an attacker.
 *
 * Demo password convention: `pass-<username>` (for example `pass-alice`, `pass-user07`).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const LEGIT_USERS: readonly string[] = Object.freeze(["alice", "bob", "carol"]);
export const POOL_USERS: readonly string[] = Object.freeze(
  Array.from({ length: 50 }, (_, i) => `user${String(i + 1).padStart(2, "0")}`),
);

export const demoPassword = (username: string) => `pass-${username}`;

const USERS: ReadonlyMap<string, string> = new Map(
  [...LEGIT_USERS, ...POOL_USERS].map((u) => [u, demoPassword(u)] as const),
);

/** Compared against when the username doesn't exist, so unknown users cost the same work. */
const DUMMY_PASSWORD = "dummy-password-never-matches-anything";

/** Constant-time string compare. Hashing first gives equal-length buffers whatever the input lengths. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * True iff the username exists and the password matches. Always performs exactly one comparison,
 * so response timing doesn't reveal whether a username is valid.
 */
export function verifyCredentials(username: string, password: string): boolean {
  const expected = USERS.get(username);
  const matches = safeEqual(password, expected ?? DUMMY_PASSWORD);
  return expected !== undefined && matches;
}

export function userCount(): number {
  return USERS.size;
}
