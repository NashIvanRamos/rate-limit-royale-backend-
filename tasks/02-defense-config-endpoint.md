# 02: Defense config and `POST /api/defense`

## Goal
Hold the active defense (algorithm, limits, keying) in memory and let the frontend deploy a new
one each round, which resets all limiter state (doc §5 Endpoints, §4 `config`).

## Config store (`src/config/defense.ts`)
```ts
type Algorithm = "fixed" | "sliding" | "token";
type KeyBy = "ip" | "user";
interface DefenseConfig { algorithm: Algorithm; maxRequests: number; windowMs: number; keyBy: KeyBy }
```
- A `DefenseState` object created inside `createApp()` (not a module singleton, so tests stay isolated):
  `{ config, limiter, deployedAt, loginLimiter }`.
- Default at boot: `{ algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" }`.
- `deploy(config, now)` builds a new limiter via `createLimiter` with `epochMs = now`, resets the
  login limiter (task 04) and stats (task 07), and records `deployedAt`.

## Endpoint (`src/routes/defense.ts`)
`POST /api/defense`, no auth (doc §5).

Validation (400 `{ error: "invalid_config", details: [...] }` on failure):
- `algorithm` ∈ fixed | sliding | token
- `maxRequests` integer 5..100 (matches slider range, doc §2)
- `windowMs` integer 1000..60000
- `keyBy` ∈ ip | user
- Reject unknown fields. Hand-rolled validation (no new deps).

Response 200:
```json
{ "config": { ... }, "deployedAt": 1731234567890, "windowEpochMs": 1731234567890 }
```
`windowEpochMs` lets the Edge Exploit scenario (round 2) schedule bursts around a real
fixed-window boundary.

Also add `GET /api/defense` returning the current config (handy for the preview panel and curl debugging).

## Tests (`test/defense.test.ts`)
- Valid body → 200 with echoed config.
- Each invalid field (out of range, wrong type, missing, extra) → 400.
- Deploy resets state: exhaust a key, redeploy, the same key is allowed again.
- Switching algorithm changes `limiter.name`.

## Acceptance criteria
- Every round can start from clean limiter state with a single POST.
- `/api/health` and `/api/defense` are never rate limited.

## Notes
- No auth on `/api/defense` is acceptable for a local demo. Call it out in the README ("in prod this is an admin-only control plane").
