# 08: Day 1 verification suite

## Goal
Meet the doc's Day 1 "done when": *the server returns the correct status for every case, for all
three algorithms* (doc §10 Day 1, §12 "All three limiters pass the Day 1 curl checks").

## Part A: automated integration tests (`test/day1.test.ts`)
For each `algorithm` in `fixed | sliding | token`, start a fresh app on port 0, deploy
`{ algorithm, maxRequests: 5, windowMs: 2000, keyBy: "user" }`, and assert:

| # | Case | Expected |
|---|------|----------|
| 1 | No token | 401 `missing_token` |
| 2 | Forged signature | 401 `invalid_signature`, **limiter count unchanged** (stats/`size()`) |
| 3 | `alg: none` | 401 `invalid_signature` |
| 4 | Expired token | 401 `expired` |
| 5 | Malformed token | 401 `malformed` |
| 6 | Valid token × 5 | 200 × 5, then 429 with `Retry-After` |
| 7 | After waiting `retryAfterMs` | 200 again |

Algorithm-specific checks over HTTP (use `windowEpochMs` from the deploy response to aim at the boundary):
- **Fixed:** 5 just before the boundary and 5 just after → 10 × 200 (edge double burst).
- **Sliding:** same pattern → only 5 × 200 within any 2s span.
- **Token:** 5 instant → 200. The 6th → 429. After `windowMs/5` ms → 1 more 200.

Real-time HTTP tests should stay short (windows ≤ 2s). Precise behaviour is already covered by the
fake-clock unit tests in task 01, so these only confirm the wiring.

## Part B: curl-style smoke script (`scripts/smoke.ts`, `npm run smoke`)
Runs against an already running server (`BASE_URL`, default `http://localhost:3000`) and prints
a table of PASS/FAIL per case per algorithm. Exits non-zero on any failure. This is what gets shown
live and pasted into the README.

Also add `docs/curl.md` (or a README section) with copy-paste curl commands for each case, including
the `alg: none` token built with `printf`/`base64`.

## Acceptance criteria
- `npm test` green. `npm run smoke` shows every case PASS for all three algorithms.
- The full suite runs in under ~20s.
