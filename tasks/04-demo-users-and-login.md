# 04: Demo users and `POST /api/login`

## Goal
Demo login that issues short-lived HS256 JWTs, protected by its own IP-keyed limiter so
credential stuffing (round 4) is stopped, while account rotation (round 5) can still log in
(doc §5 Auth, Keying Rules, §7).

## Users (`src/config/users.ts`)
- `user01`…`user50`: account pool (round 5 attacker rotation, round 4 stuffing targets).
- `alice`, `bob`, `carol`: legitimate clients in every round.
- Plain in-memory `Map<username, password>` with demo passwords (for example `pass-user01`). Hashing is explicitly out of scope (doc §1).
- Compare passwords with `crypto.timingSafeEqual` on equal-length buffers, and do the comparison even for
  unknown users (dummy compare) so response timing doesn't reveal valid usernames. Cheap, and a good interview point.
- Export the legitimate/pool split so the frontend scenarios and task 09 use the same names.

## JWT signing (`src/auth/jwt.ts`)
- `signAccessToken(sub)` → `jwt.sign({ sub }, env.JWT_SECRET, { algorithm: "HS256", expiresIn: "15m" })`.
  Payload is `{ sub, iat, exp }`. Nothing sensitive (doc §5).
- `signExpiredToken(sub)` (demo only): `iat` and `exp` in the past (for example `exp = now - 60s`).

## Endpoint (`src/routes/login.ts`)
`POST /api/login` body `{ username, password }`.
- 400 `{ error: "bad_request" }` if fields are missing or not strings.
- 401 `{ error: "invalid_credentials" }` on a wrong username or password (same response for both).
- 200 `{ token, tokenType: "Bearer", expiresIn: 900, sub }`.

### Login limiter (always keyed by IP)
- Key: `login:${clientIp}` (task 03). Never the username, since nobody is authenticated yet.
- **Counts failed attempts** (decision, see tasks/README.md): use a sliding window log limiter,
  5 failures / 60s per IP.
  - Before checking credentials, *peek*: if the IP is already over the failure budget → 429 + `Retry-After`,
    and the credentials are **not** checked (stuffing attempts stop being useful).
  - On failure, record it. On success, don't consume.
- This needs a non-consuming `peek(key, now)` on the sliding limiter, or a small dedicated
  `FailureCounter`. Prefer adding an optional `peek` to the sliding log rather than bending the shared interface.
- The login limiter is independent of the player's configured defense, and `POST /api/defense` resets it.

### Demo expired token
`POST /api/demo/expired-token` (mounted only when `DEMO_MODE=true`), same body and credential check as
login, returns `{ token }` with a past `exp`. It feeds the expired-token legitimate client in round 4
(doc §6), since the browser can't mint one without the secret.

## Tests (`test/login.test.ts`)
- Valid creds → 200. Decoded token has `sub`, `iat`, `exp`, header `alg: HS256`, and `exp - iat === 900`.
- Wrong password and unknown user → identical 401 body.
- 5 failures from IP A → the 6th attempt is 429 with `Retry-After` even with *correct* creds. IP B is unaffected.
- 50 successful logins from one IP → all 200 (round 5 is possible).
- `POST /api/defense` clears login lockout.
- Expired-token endpoint is 404 when `DEMO_MODE=false`.

## Acceptance criteria
- Login works for all 53 users. Round 4 stuffing from one IP gets 429s after the budget.
- The secret never appears in any response or log line.
