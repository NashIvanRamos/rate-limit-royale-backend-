# 06: Redis failure mode (fail open vs. fail closed)

## Goal
Decide, implement and explain what happens when Redis is down. This is the classic follow-up question, so have a measured answer.

## Design
- `REDIS_FAILURE_MODE=open|closed` (default `open`).
  - **Open:** allow the request, log a warning, and set `X-RateLimit-Degraded: true`. The API stays up, but is unprotected.
  - **Closed:** respond `503 { error: "limiter_unavailable" }` + `Retry-After: 1`. Protection holds, but the API is down for everyone.
- Short command timeout (~50 ms) and ioredis `maxRetriesPerRequest: 1`, so a dead Redis fails fast instead of piling up requests.
- Login guard: **always fail closed**. An outage must not turn into an open door for credential stuffing. Say why
  the two differ: `/api/resource` is about availability, login is about security.
- `/api/health` reports `redis: "up" | "down"`.

## Tests
- Point at a closed port: in open mode `/api/resource` returns 200 with the degraded header. In closed mode it returns 503.
  Login returns 503 in both.
- Manual check in the cluster: stop Redis mid-round and watch the mode decide the outcome.

## Acceptance criteria
- Both modes are tested, and the README has a 3-line explanation of the default choice.
