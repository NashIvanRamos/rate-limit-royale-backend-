# Rate Limit Royale: Backend

The Express API behind **Rate Limit Royale**, a five-round game where the player configures a rate-limit defense
(algorithm, limit, window, key by IP or user), deploys it to this server, and watches real attack traffic hit it.
Every number the game shows comes from real HTTP responses: **200** accepted, **429** blocked, **401** rejected auth.

TypeScript, Express 5, `jsonwebtoken`, all state in memory. 223 tests, no test dependencies beyond `node:test`.

- [Run it](#run-it)
- [API reference](#api-reference)
- [Middleware order](#middleware-order)
- [Limiter trade-offs](#limiter-trade-offs)
- [Keying strategy](#keying-strategy)
- [JWT](#jwt)
- [Login limiting](#login-limiting)
- [Measured results](#measured-results)
- [Honest limits](#honest-limits) and [what I'd change for production](#what-id-change-for-production)

---

## Run it

Developed and tested on Node 24.

```bash
npm install
cp .env.example .env        # then set JWT_SECRET (≥ 32 chars):
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npm run dev                  # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload (`tsx watch`). |
| `npm test` | All unit and integration tests (~1.5s). Integration tests start the app on port 0 with a fake clock. |
| `npm run typecheck` | `tsc` over `src`, `test` and `scripts`. |
| `npm run smoke` | Day 1 checks against the running server, real clock. PASS/FAIL table, exits 1 on failure (~9s). |
| `npm run replay -- --round 5 --keyBy both` | Replays a game round against the running server like the browser does, and cross-checks against `/api/stats`. |
| `npm run build && npm start` | Compile to `dist/` and run. |

`smoke` and `replay` redeploy the defense while they run (resetting limiter state) and leave the server on the default
defense. Don't run them in the middle of a game round. `BASE_URL` points them at another server.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | (required) | ≥ 32 characters. The server refuses to start without it and never logs it. |
| `PORT` | `3000` | |
| `TRUST_PROXY` | `loopback` | Express `trust proxy`. See [simulated IPs](#keying-strategy). `false` = real socket IP only. |
| `DEMO_MODE` | `false` | `true` enables `/api/demo/*` (round 4's expired token). `.env.example` sets it to `true`. |
| `CORS_ORIGIN` | `http://localhost:5173` | The Vite dev server. |

Config is validated once at boot (`src/config/env.ts`). Invalid config lists every problem and exits.

---

## API reference

Every error has the shape `{ error: string, reason?: string, retryAfterMs?: number }`. No stack traces in responses.

| Method | Path | Auth | Limited by | Purpose |
|---|---|---|---|---|
| GET | `/api/health` | none | never | Liveness, uptime, active algorithm and keying. |
| GET / POST | `/api/defense` | none | never | Read / deploy the defense. Deploy resets all limiter state, login lockouts and stats. |
| POST | `/api/login` | none | failed attempts per IP | Exchange demo credentials for a 15-minute JWT. |
| GET | `/api/resource` | Bearer JWT | the deployed defense | The endpoint under attack. |
| GET | `/api/stats` | none | never | The server's own tally for the current round. |
| POST | `/api/demo/expired-token` | none | failed attempts per IP | `DEMO_MODE` only: a correctly signed, already-expired token. |
| GET | `/api/demo/whoami` | none | never | `DEMO_MODE` only: the client IP the server sees. |

### `POST /api/defense`
```jsonc
// request: all four fields required, unknown fields rejected, no type coercion
{ "algorithm": "fixed" | "sliding" | "token", "maxRequests": 5..100, "windowMs": 1000..60000, "keyBy": "ip" | "user" }
// 200
{ "config": { ... }, "deployedAt": 1794409469124, "windowEpochMs": 1794409469124 }
// 400
{ "error": "invalid_config", "details": [{ "field": "maxRequests", "message": "must be between 5 and 100" }] }
```
Fixed-window boundaries are at `windowEpochMs + k × windowMs`. Round 2 uses this to aim its bursts.

### `POST /api/login`
```jsonc
// request
{ "username": "alice", "password": "pass-alice" }
// 200
{ "token": "eyJ...", "tokenType": "Bearer", "sub": "alice", "expiresIn": 900 }
// 400 { "error": "bad_request" }          missing/oversized fields or invalid JSON (not counted as a failure)
// 401 { "error": "invalid_credentials" }  same response for unknown user and wrong password
// 429 { "error": "rate_limited", "retryAfterMs": 41200 } + Retry-After
```
Demo users: `alice`, `bob`, `carol` (legitimate clients) and `user01`–`user50` (the attacker's account pool).
Password convention: `pass-<username>`.

### `GET /api/resource`
```jsonc
// 200
{ "ok": true, "sub": "alice", "servedAt": 1794409470012 }
// 401 + WWW-Authenticate: Bearer realm="rate-limit-royale", error="invalid_token", ...
{ "error": "unauthorized", "reason": "missing_token" | "invalid_signature" | "expired" | "malformed" }
// 429 + Retry-After: 2
{ "error": "rate_limited", "retryAfterMs": 1843 }
```
Every response that reaches the limiter carries `RateLimit-Limit` and `RateLimit-Remaining`. All three headers are
exposed through CORS so the browser can read them.

| 401 reason | When |
|---|---|
| `missing_token` | No `Authorization: Bearer …` header. |
| `invalid_signature` | Wrong secret, tampered payload, `alg: none`, or any algorithm other than HS256. |
| `expired` | Correctly signed, `exp` in the past. Signature is checked first, so a forged token never reports `expired`. |
| `malformed` | Not a JWT (`abc`, `a.b.c`), > 4 KB, or a valid signature over a payload without a string `sub` and numeric `exp`. |

`Retry-After` is whole seconds, rounded up, minimum 1 (RFC 9110). `retryAfterMs` is exact, and the client is allowed
again at exactly `now + retryAfterMs` (tested for all three algorithms).

### `GET /api/stats`
```jsonc
{
  "since": 1794409469124,                     // last deploy
  "resource": { "total": 13, "s200": 5, "s401": 5, "s429": 3, "other": 0,
                "byReason": { "missing_token": 1, "invalid_signature": 2, "expired": 1, "malformed": 1 } },
  "login":    { "total": 9, "s200": 1, "s400": 2, "s401": 5, "s429": 1, "other": 0 },
  "trackedKeys": 3,                           // limiter.size(): keys held in memory right now
  "topKeys": [{ "key": "ip:10.6.6.6", "requests": 300, "allowed": 13, "blocked": 287 }],
  "untrackedKeyRequests": 0
}
```
Lets the game print "server confirms" next to its own tally. The server can't know which clients are legitimate
(that label lives in the scenario script), so `legitBlocks` is computed client-side.

---

## Middleware order

```
request
  │
  ├─ trust proxy, CORS
  ├─ stats tracker (counts /api/resource and /api/login on finish; before the body parser, so bad JSON is counted)
  ├─ JSON body (10 KB limit)
  │
  ├─ /api/health, /api/defense, /api/stats ────────────────► never limited
  ├─ /api/login ─► login failure limiter (per IP) ─► credentials
  │
  └─ /api/resource
        1. authenticate ── bad/missing token ──► 401 {reason}   STOP: the limiter is never touched
        2. select key   ── keyBy user → user:<sub>, keyBy ip → ip:<client ip>
        3. limiter      ── over budget ──► 429 + Retry-After
        4. handler      ──► 200
```

**Why auth runs before the limiter:** if the limiter ran first, it would have to key unverified requests by something.
Keyed by the token's claimed `sub`, an attacker could forge tokens for `alice` and drain *alice's* budget without
knowing her password. Keyed by IP, every forged request would still eat into a shared budget. With auth first, a
request has to prove its identity before it can spend anyone's budget.

The proof is in the tests, for all three algorithms:
- `test/pipeline.test.ts` ("ORDER PROOF") sends 50 each of missing, forged, `alg: none`, expired, tampered and garbage
  tokens claiming the victim's identity, under both `keyBy` modes. Then it checks the limiter holds zero keys and the
  victim still gets the full quota.
- `test/scenarios.test.ts`, round 4: the forgers impersonate `alice` and `bob` for 6 seconds. Both still get 200 on
  every request, and `/api/stats` shows only their 2 keys in the limiter.
- Smoke case 2 checks the same against a live server.

The flip side, which is worth saying out loud: invalid tokens are rejected before any limiting, so a flood of garbage
tokens costs the server a signature check per request. HMAC verification is cheap, but in production a coarse
per-IP limit at the edge (NGINX `limit_req`, a WAF) would sit in front of this. See
[production](#what-id-change-for-production).

---

## Limiter trade-offs

All three implement one interface (`src/algorithms/types.ts`): `allow(key, now) → { allowed, retryAfterMs, remaining }`.
Time is injected, so the algorithms are pure and every test runs on a fake clock. **Denied requests never consume
budget**, so hammering while blocked doesn't extend a lockout.

| | Fixed window | Sliding window log | Token bucket |
|---|---|---|---|
| State per key | 1 counter + window index | 1 timestamp per accepted request (up to `max`) | 2 numbers (tokens, last refill) |
| Memory per key | O(1) | **O(max)** | O(1) |
| Accuracy | Approximate | **Exact**: never more than `max` in any `windowMs` span | Exact average rate, bursty short-term |
| Bursts | Up to `max` at any time in a window | Up to `max` per rolling window | Up to `capacity`, then the refill rate |
| Boundary issue | **Yes:** `max` just before + `max` just after a boundary = 2× in moments | No | No (a burst is capped at capacity) |
| Round 2, measured (10 per 2s) | **20 of 20 through** | 10 of 20 | 12 of 20 |

**Which I'd pick for a public API: token bucket.** Real clients are bursty (a page load fires several calls at once),
and a token bucket lets that through while enforcing the long-run rate. It's O(1) memory per key, and there's no
boundary to exploit. It's also what most API gateways and cloud providers expose ("rate" plus "burst"), so it's easy
to document for API consumers. I'd use a **sliding window** where the limit is a hard guarantee rather than an average,
for example "5 password resets per hour". There the memory cost is fine because `max` is small. **Fixed window** is the
cheapest and simplest to run in Redis (`INCR` + `EXPIRE`). It's fine for coarse quotas such as a daily allowance,
where a 2× burst at midnight doesn't matter.

Implementation details worth knowing:
- Fixed windows are aligned to deploy time (`windowEpochMs`), not the Unix epoch, so the boundary is predictable for the edge-exploit round.
- The sliding log prunes old timestamps on access and deletes a key once its log is empty.
- Token bucket refill is lazy (computed from elapsed time on each call, no timers), clamps at capacity after long idle periods, and tolerates the clock moving backwards.

---

## Keying strategy

| Request | Key | Why |
|---|---|---|
| `POST /api/login` | always client IP | Nobody is authenticated yet, so the IP is the only identity there is. |
| `/api/resource`, `keyBy: "user"` | `user:<sub>` from the verified JWT | A verified identity: users on a shared IP don't share a budget. |
| `/api/resource`, `keyBy: "ip"` | `ip:<client ip>` | One budget per network origin, however many accounts it holds. |

Keys are prefixed (`user:` / `ip:`) so a username can never collide with an IP string.

**Each choice has a failure mode, and round 5 is about one of them:**
- **Keying by user gets gamed by account rotation.** If accounts are cheap to make, an attacker signs up 50 and gets
  50 budgets. Measured in round 5, where 50 accounts on one IP send 300 requests over 10s against "10 per 10s":
  **all 300 got through keyed by user, vs. 10–19 keyed by IP** (15–30× less, depending on the algorithm).
- **Keying by IP breaks behind shared NAT and proxies.** An office, a university or a mobile carrier can put thousands
  of real users behind one IP, and they'd all share a budget and block each other. Behind a reverse proxy, every
  request comes from the proxy's IP unless you configure **`trust proxy`**. Trust too much and any client can
  pick its own IP by sending `X-Forwarded-For`.
- **Most real systems combine both:** a per-user limit for fairness, plus a looser per-IP (or per-subnet/ASN) limit to
  catch account farms, plus account-creation friction (email verification, CAPTCHA).

### Simulated client IPs (a demo affordance)
A browser sends every request from one real IP, so "key by IP" would be meaningless in the game. The server sets
`trust proxy` to **`loopback`**: Express honours `X-Forwarded-For` only when the request comes straight from
`127.0.0.1`/`::1` (the Vite dev proxy). The game sets `X-Forwarded-For: 10.0.0.7` per simulated client. Express takes
the rightmost untrusted address, so a spoofed chain like `1.2.3.4, 10.0.0.7` still resolves correctly, and the code
never parses the header itself. **In production you'd trust only your own proxy's address**, or set `TRUST_PROXY=false`.

**`X-Client-Id` is not used anywhere.** An earlier design let the client name its own identity in a header. That makes
every rate limit optional: an attacker just sends a new ID per request. Identity now comes only from a verified JWT
or the connection.

---

## JWT

- **Pinned algorithm.** `jwt.verify` is always called with `algorithms: ["HS256"]`. Without that, the token's own
  header decides how it gets verified. `alg: none` would mean "no signature, trust me", so anyone could write
  `{"sub": "admin"}` and be accepted. And on servers that also accept RS256, an attacker can sign an HS256 token
  using the *public* key as the HMAC secret (algorithm confusion). Here `alg: none` (with or without a signature
  segment) and HS512 tokens get `invalid_signature`, as does anything else that isn't HS256
  (`test/authenticate.test.ts`, smoke case 3).
- **The payload is readable by anyone.** A JWT is signed, not encrypted: base64-decode the middle segment and you
  can read it. The payload is only `{ sub, iat, exp }`, with nothing sensitive in it.
- **15-minute expiry,** checked against the injected clock so tests can move time.
- **No revocation before expiry.** The server keeps no session, so a stolen token stays valid until `exp`. Revoking
  one needs a server-side denylist (a `jti` checked on every request, which brings back the state JWTs were meant
  to avoid). The usual trade-off is **short-lived access tokens plus refresh tokens**: the access token is
  verified without a lookup, and the refresh token (long-lived, stored server-side, rotated on use) is the thing you revoke.
- Both `/api/login` failure modes (unknown user, wrong password) give the same response and do the same work
  (a constant-time comparison runs even for unknown users, against a dummy password), so login doesn't leak which usernames exist.

---

## Login limiting

`/api/login` has its own limiter, independent of the player's defense: **5 failed attempts per IP per 60s**
(sliding log, `src/auth/loginGuard.ts`). Once an IP is over budget it gets 429 *before* the credentials are checked,
so credential stuffing stops being useful. A malformed body is a 400 and doesn't count.

**Why only failures count:** the two attack rounds need opposite things from login.
- **Round 4 (credential stuffing):** 60 wrong passwords from one IP. Measured: exactly **5 × 401, then 55 × 429**.
- **Round 5 (account rotation):** 50 *valid* pool accounts log in from one attacker IP. If every attempt counted,
  the attacker would be locked out after 5 and the boss wave, which tests the `keyBy` toggle, would never start. Counting
  failures stops guessing without stopping legitimate logins. It's also a common real-world pattern: lock out on
  failures, not on successes.

Real systems add a per-*account* failure limit too, against slow guessing of one account from many IPs. I left that out
because it opens an attacker-triggered lockout of a victim's account, which needs its own mitigation (CAPTCHA, not lockout).

---

## Measured results

Everything below comes from `npm run smoke` and `npm run replay` against a local server (Node 24, macOS).
The replay cross-checks itself against `/api/stats`, and **every run matched exactly**.

### Day 1 smoke test (`maxRequests 5, windowMs 2000, keyBy user`)
```
Case                                                            fixed    sliding  token
───────────────────────────────────────────────────────────────────────────────────────────
1. No token → 401 missing_token                                 PASS     PASS     PASS
2. Forged signature → 401 invalid_signature, limiter untouched  PASS     PASS     PASS
3. alg: none → 401 invalid_signature                            PASS     PASS     PASS
4. Expired token → 401 expired                                  PASS     PASS     PASS
5. Malformed token → 401 malformed                              PASS     PASS     PASS
6. Valid × 5 → 200 × 5, then 429 + Retry-After                  PASS     PASS     PASS
7. After waiting retryAfterMs → 200                             PASS     PASS     PASS
8. Algorithm behaviour (edge burst / refill)                    PASS     PASS     PASS

Case 8: fixed: 5 just before + 5 just after a boundary → 10 × 200 (edge double burst)
        sliding: 5 just before + 5 just after a boundary → only 5 × 200
        token: 5 instant → 200, 6th → 429, after windowMs/5 → exactly 1 more 200

All 24 checks passed in 9.1s.
```
Copy-paste curl versions of each case: [`docs/curl.md`](docs/curl.md).

### The five rounds (attacker requests that got through, key by IP unless noted)

| Round | Config | Fixed | Sliding | Token | Legit blocks |
|---|---|---|---|---|---|
| 1. Steady Flood (200 req / 10s) | 10 per 10s | 12 | 10 | 19 | 0 |
| 2. Edge Exploit (2 × 10 across a boundary) | 10 per 2s | **20** ✗ | 10 | 12 | 0 |
| 3. Burst Attack (100 req / 5s) | 10 per 2s | 30 | 30 | 34 | 0 |
| 4. Stuffing + forged tokens (120 attack req) | 10 per 10s | 0 | — | — | 0 (carol: 4 × 401 `expired`, not penalised) |
| 5. Boss wave, **key by user** (300 req, 50 accounts) | 10 per 10s | **300** ✗ | **300** ✗ | **300** ✗ | 0 |
| 5. Boss wave, **key by IP** | 10 per 10s | 13 | 10 | 19 | 0 |

- **Round 2** is the fixed window's boundary weakness: the whole double burst got through, and the round isn't cleared.
- **Round 3**: the token bucket admits its 10-token burst up front, then the refill rate (34). The sliding window
  admits exactly 10 per 2s span (30).
- **Round 5**: the same 300 requests go from 300 through to 10–19 through just by flipping the key.
- **Over-tight defense** (5 per 60s, round 1): the attacker gets only 5 through, but legitimate users take
  **4 × 429**, and the round scores 300/500. The game balances blocking attackers against blocking customers.

Scoring is the frontend's job, but `src/scenarios/results.ts` holds a tested reference implementation. The allowance
is one quota plus the configured rate for the attack's duration, so a token bucket isn't penalised for its refill.

---

## Honest limits

This is a single-process demo. Here's what it deliberately doesn't do:

- **In-memory state.** Limiter counters, login lockouts and stats live in the process. Run two instances behind a
  load balancer and each client gets 2× the limit, and a restart forgets everything. Multi-instance needs a shared
  store. See below.
- **Simulated IPs** come from `X-Forwarded-For`, trusted from loopback only. That's correct for the local demo, but
  in production you'd trust only your real proxy.
- **`/api/defense` and `/api/stats` are unauthenticated.** They're the game's control panel. In production these
  would be admin-only, on a separate port or network.
- **Plaintext demo passwords** (`pass-<username>`) in a hard-coded list. Real users would be in a database with
  bcrypt/argon2 password hashes.
- **No stale-key sweeping.** Fixed-window and token-bucket keys stay in memory until the next deploy, and sliding-log
  keys are dropped only when the key is accessed again. A long-running server facing many distinct keys would need a
  periodic sweep, or TTLs in Redis. `trackedKeys` in `/api/stats` makes this visible.
- **Legitimacy labels live client-side.** The server can't tell legitimate traffic from attack traffic (if it could,
  rate limiting would be unnecessary), so "legitimate blocks" is computed by the game from its scenario script.
- **No refresh tokens or revocation** (see [JWT](#jwt)).

### What I'd change for production

- **Redis for limiter state.** Fixed window → `INCR` + `EXPIRE`. Sliding log → a sorted set (`ZADD`,
  `ZREMRANGEBYSCORE`, `ZCARD`). Token bucket → a small **Lua script**, so the read-refill-decrement runs atomically
  and concurrent requests can't race. The `RateLimiter` interface stays the same; only the storage changes. Costs
  to weigh: one network round-trip per request (~1 ms), and a decision about **fail-open vs. fail-closed** when Redis
  is down. Fail open keeps the API available; fail closed keeps the protection.
- **A reverse proxy (NGINX or a cloud load balancer) in front.** It terminates TLS, sets `X-Forwarded-For` from the
  real connection (with `trust proxy` set to the proxy's address only), and applies a coarse `limit_req` per IP,
  so cheap floods (including garbage-token floods) are dropped before they reach Node. The app keeps the smarter
  limits that need a verified identity.
- **Layered keys:** per-user limits plus a looser per-IP/subnet limit, plus friction on account creation.
- **Observability:** emit allow/deny counters per key type and algorithm to metrics, not just an in-memory `/api/stats`.

---

## Project layout

```
src/
├── server.ts, app.ts           entry; app builder (routes mounted in pipeline order)
├── config/                     env validation, defense state + validation, demo users
├── algorithms/                 fixedWindow, slidingWindowLog, tokenBucket behind one RateLimiter interface
├── auth/                       JWT sign/verify + reason mapping, login failure limiter
├── middleware/                 authenticate, rateLimit (key selection), clientIp, stats
├── routes/                     defense, login (+ demo expired-token), resource, stats
├── scenarios/                  the five rounds, tally and reference scoring (shared shape with the frontend)
└── project_overview.md         the design doc
scripts/                        smoke (Day 1 checks), replay (rounds against a live server)
test/                           node:test suites; integration tests run the real app on port 0 with a fake clock
docs/curl.md                    Day 1 checks as copy-paste curl
tasks/                          the backend task breakdown this was built from
Frontend-Steps.md               the frontend's integration guide for this API
```
