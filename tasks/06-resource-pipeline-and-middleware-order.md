# 06: Resource pipeline and middleware order

## Goal
Wire `GET /api/resource` as **auth → key selection → limiter → handler**, so forged or expired
tokens never drain a legitimate client's budget (doc §5 Middleware order, §11).

## Rate-limit middleware (`src/middleware/rateLimit.ts`)
```ts
export function rateLimit(state: DefenseState): RequestHandler
```
1. **Key selection** (`selectKey(req, config)`):
   - `keyBy === "user"` and `req.auth` present → `user:${req.auth.sub}`
   - otherwise → `ip:${clientIp(req)}` (task 03)
   - Prefix keys so a username can never collide with an IP string.
2. `const d = state.limiter.allow(key, Date.now())`. Read `state.limiter` **at request time** so a
   redeploy mid-round takes effect immediately.
3. Denied → `429 { error: "rate_limited", retryAfterMs }` plus `Retry-After: ceil(retryAfterMs/1000)` (seconds,
   minimum 1).
4. Allowed → set informational headers `RateLimit-Limit`, `RateLimit-Remaining`, then `next()`.

## Route (`src/routes/resource.ts`)
`GET /api/resource` = `[authenticate, rateLimit(state), handler]`
Handler returns `200 { ok: true, sub, servedAt }`.

## Mount order in `createApp()`
1. CORS, JSON body parser (with a small `limit`, for example `10kb`), `trust proxy`.
2. Stats middleware (task 07, wraps everything under `/api/resource` and `/api/login`).
3. `/api/health`, `/api/defense` (unlimited).
4. `/api/login` (its own IP limiter, task 04), `/api/demo/*` when DEMO_MODE.
5. `/api/resource`.
6. 404 JSON handler and error handler (no stack traces in responses, malformed JSON body → 400).

## Health (`src/routes/health.ts`)
Extend to `{ status: "healthy", service, uptimeS, algorithm, keyBy }` so the status pill and the preview
can show the live server config. Never limited.

## Tests (`test/pipeline.test.ts`)
- **Order proof:** deploy `maxRequests: 5`. From IP X send 50 forged-token requests (all 401), then 5
  valid-token requests from IP X → all 200. The 6th → 429. Forged traffic consumed nothing.
- Same with expired and `alg: none` tokens.
- `keyBy: "ip"`: two users on the same IP share a budget, and one user on two IPs gets two budgets.
- `keyBy: "user"`: two users on the same IP get separate budgets.
- 429 includes `Retry-After` and it's readable cross-origin (exposed header).
- Redeploy mid-sequence resets the budget.
- Run the suite for all three algorithms (`for (const algorithm of [...])`).

## Acceptance criteria
- Status codes: no token → 401, bad token → 401, valid over limit → 429, valid under limit → 200.
- 401 responses never change limiter state (asserted via `limiter.size()` staying 0).
