# Backend Tasks: Rate Limit Royale

Source: `src/project_overview.md` (design doc). This folder contains only the **backend** work
(Express API, JWT auth, limiters, keying, verification, docs). Frontend work (React phases,
scheduler, styling, video) is out of scope here, but tasks note where the backend has to
support a frontend need.

## Task order

| # | Task | Depends on | Design doc ref |
|---|------|-----------|----------------|
| 00 | [Project setup and hygiene](00-project-setup-and-hygiene.md) | none | §1, §9 |
| 01 | [Limiter interface and algorithms](01-limiter-interface-and-algorithms.md) | 00 | §5 Limiter Interface |
| 02 | [Defense config and `/api/defense`](02-defense-config-endpoint.md) | 01 | §5 Endpoints |
| 03 | [Client identity and simulated IPs](03-client-identity-and-trust-proxy.md) | 00 | §5 Keying Rules, §11 |
| 04 | [Demo users and `/api/login`](04-demo-users-and-login.md) | 01, 03 | §5 Auth, Keying Rules |
| 05 | [JWT verification middleware](05-jwt-verification-middleware.md) | 04 | §5 Auth |
| 06 | [Resource pipeline and middleware order](06-resource-pipeline-and-middleware-order.md) | 02, 03, 05 | §5 Middleware order |
| 07 | [Server-side stats (verification)](07-server-stats-endpoint.md) | 06 | §1 "numbers come from the server", §11 |
| 08 | [Day 1 verification suite](08-day1-verification-suite.md) | 06 | §10 Day 1, §12 |
| 09 | [Scenario support and backend replays](09-scenario-support-and-replays.md) | 07, 08 | §7, §12 |
| 10 | [Backend README and interview notes](10-backend-readme.md) | all | §10 Day 4, §11, §12 |

The critical path for the doc's "Day 1: done when" is 00 → 01 → 02 → 03 → 04 → 05 → 06 → 08.
07, 09 and 10 support Days 2 to 4.

## Target file layout (TypeScript, adapted from doc §9)

The doc's §9 layout is plain JS (`server/index.js`, `auth.js`, ...). This repo is already set up
as TypeScript in `src/` with `algorithms/`, `config/`, `middleware/` and `routes/` folders, so
the tasks map onto that layout:

```
src/
├── server.ts                  # entry: loads env, starts listening
├── app.ts                     # builds the Express app, mounts routes in order
├── config/
│   ├── env.ts                 # typed env (PORT, JWT_SECRET, TRUST_PROXY, DEMO_MODE)
│   ├── defense.ts             # current DefenseConfig + active limiter (in memory)
│   └── users.ts               # in-memory demo users
├── algorithms/
│   ├── types.ts               # RateLimiter interface
│   ├── fixedWindow.ts
│   ├── slidingWindowLog.ts
│   ├── tokenBucket.ts
│   └── index.ts               # createLimiter(config)
├── auth/
│   └── jwt.ts                 # sign / verify helpers, reason mapping
├── middleware/
│   ├── authenticate.ts        # Bearer JWT → req.auth or 401 {reason}
│   ├── rateLimit.ts           # key selection + allow() → 429 + Retry-After
│   └── stats.ts               # response counters (task 07)
├── routes/
│   ├── health.ts
│   ├── defense.ts
│   ├── login.ts
│   ├── resource.ts
│   └── stats.ts
└── types/express.d.ts         # req.auth augmentation
test/                          # node:test + tsx
scripts/smoke.ts               # curl-style Day 1 checks against a running server
```

## Conventions

- **Time is injected.** Limiters take `now` (ms). Only middleware calls `Date.now()`. Tests use fake clocks.
- **Tests:** built-in `node:test` run through `tsx`. No extra test deps. Integration tests start
  the app on port 0 and use global `fetch`.
- **Error shape:** `{ error: string, reason?: string, retryAfterMs?: number }`.
- **No `X-Client-Id`** anywhere (doc §5 Keying Rules).

## Decisions I made (doc is silent or ambiguous). Confirm or override.

1. **Simulated client IPs (task 03).** The browser sends every request from one real IP, so
   "Key by IP" and "client IPs" in the briefing mean nothing unless the server can tell simulated
   clients apart. Plan: `trust proxy` set to loopback only, and the frontend's requests (via the
   Vite proxy) carry `X-Forwarded-For: 10.0.0.N`. This is a **simulation affordance** and gets
   documented honestly in the README as "only trust your own proxy in production".
2. **Login limiter counts failed attempts per IP (task 04).** Round 4 (credential stuffing) needs
   login limited per IP. Round 5 needs 50 accounts to log in successfully, and if they came from
   the attacker's single IP a plain "all attempts" limit would stop the boss wave before it starts.
   Limiting *failed* attempts per IP satisfies both rounds and is a real-world pattern.
3. **Fixed windows are aligned to deploy time (task 01/02).** `/api/defense` returns
   `windowEpochMs` so the Edge Exploit script (round 2) can time bursts around a known boundary.
4. **Expired-token client (task 04).** The client can't mint an expired token without the secret,
   so a demo-only `POST /api/demo/expired-token` (enabled when `DEMO_MODE=true`) issues one.
5. **`alg: none` maps to `invalid_signature`** (task 05). The four allowed reasons have no better fit.
6. **Users:** `user01`–`user50` form the account pool (round 5 attackers), plus `alice`, `bob`, `carol`
   for legitimate clients, so legitimate and attacker identities never overlap.
7. **Denied requests are not recorded** in the sliding log, and don't consume tokens or counts.
