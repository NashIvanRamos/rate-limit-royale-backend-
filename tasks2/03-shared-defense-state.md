# 03: Shared defense state in Redis

## Goal
With `LIMITER_STORE=redis`, a deploy on **any** node applies to **all** nodes, and all nodes agree on the window epoch.

## Design
- Add the Redis client: `ioredis` (`defineCommand` makes Lua scripts easy to call), connected from `REDIS_URL`.
- Deploy writes one hash, atomically (`MULTI`):
  `defense` → `{ algorithm, maxRequests, windowMs, keyBy, deployedAt, generation }`, with `generation = INCR defense:gen`.
- **Reset without deleting keys:** every limiter key is prefixed with the generation (`rl:<gen>:ip:10.6.6.6`). A deploy
  bumps the generation, so the old keys are simply never read again and expire through their TTLs. No `SCAN`/`DEL`
  across the keyspace.
- **How nodes see a new deploy:** read the `defense` hash on each request (1 extra round-trip, ~0.2 ms locally).
  Keep it simple and correct. *Stretch:* cache it and invalidate with Redis pub/sub (`PUBLISH defense:changed`).
  Mention the trade-off: a cache is faster, but has a window where nodes disagree.
- `GET /api/defense` and `/api/health` read from Redis when the store is Redis.
- `windowEpochMs` = the shared `deployedAt`, so every node computes the same fixed-window index.

## Tests (run when `REDIS_URL` is set, skipped otherwise)
- Two apps sharing one Redis: deploy on A, and B's `GET /api/defense` returns the same config, `deployedAt` and generation.
- Deploying twice bumps the generation, and keys from the old generation aren't read.

## Acceptance criteria
- In the cluster, `POST /api/defense` through NGINX changes the behaviour of all 3 nodes.
- In-memory mode is unchanged.
