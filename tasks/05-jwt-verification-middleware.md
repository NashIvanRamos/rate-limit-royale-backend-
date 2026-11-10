# 05: JWT verification middleware

## Goal
Bearer-token verification that pins HS256, rejects `alg: none` and forged signatures, checks
expiry, and returns a precise 401 reason (doc §5 Auth, §11 "Pinned algorithm").

## Implementation (`src/middleware/authenticate.ts`, helpers in `src/auth/jwt.ts`)
1. Read `Authorization`. Missing, empty, or not `Bearer <token>` → 401 `missing_token`.
2. `jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] })`. **Always pass `algorithms`.**
3. Validate the payload shape: `sub` is a non-empty string and `exp` is a number. Otherwise `malformed`.
4. Success → `req.auth = { sub, exp }` and `next()`.

### Error → reason mapping
| Input | jsonwebtoken error | reason |
|---|---|---|
| no / non-Bearer header | (none) | `missing_token` |
| not three dot-separated parts, bad base64/JSON | `JsonWebTokenError: jwt malformed` / `invalid token` | `malformed` |
| valid shape, wrong secret | `JsonWebTokenError: invalid signature` | `invalid_signature` |
| `alg: none` (empty signature) | `jwt signature is required` | `invalid_signature` |
| `alg: HS512`/`RS256` header | `invalid algorithm` | `invalid_signature` |
| past `exp` | `TokenExpiredError` | `expired` |
| payload missing `sub` | (shape check) | `malformed` |

Match on error **class** first (`TokenExpiredError`, `JsonWebTokenError`) and then message. Keep the
mapping in one pure function `classifyJwtError(err)` that gets unit-tested on its own.

Response: `401 { error: "unauthorized", reason }` plus `WWW-Authenticate: Bearer error="invalid_token"`
(with `error_description` = reason). Never echo the token back.

## Ordering guarantee
This middleware must **not** import or touch any limiter. A 401 here returns before the rate-limit
middleware runs (task 06 enforces the order and tests it).

## Tests (`test/authenticate.test.ts`)
Build tokens by hand in the test helpers (`test/helpers/tokens.ts`, reused by tasks 08 and 09):
- `forgeSignature(sub)`: signed with the wrong secret.
- `algNone(sub)`: `base64url({"alg":"none","typ":"JWT"}).base64url(payload).` with an empty signature.
- `tamperPayload(validToken)`: swap `sub`, keep the old signature.
- `expired(sub)`: correct secret, past `exp`.
- `garbage`: `"abc"`, `"a.b.c"`, `"Bearer"` with no token.

Each one is asserted to return the exact reason from the table.

## Acceptance criteria
- `alg: none`, a forged or tampered signature, and a wrong-alg header are all rejected.
- Every 401 carries one of exactly four reasons: `missing_token`, `invalid_signature`, `expired`, `malformed`.
