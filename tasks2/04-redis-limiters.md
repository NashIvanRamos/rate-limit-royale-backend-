# 04: Redis limiters (Lua)

## Goal
`RedisStore` implementations of all three algorithms, **each decision atomic**, with the same semantics as the memory
versions. That includes "denied requests never consume budget".

## Why Lua
Every algorithm is read → decide → write. Run as separate commands, two nodes can both read "9 of 10 used", both
decide "allowed", and both write, letting 11 through. A Lua script runs atomically inside Redis, so no other command
can run in between. (`MULTI` alone isn't enough, because the decision depends on the value read.)

## Scripts (`src/algorithms/redis/*.lua`, loaded with `defineCommand`)
- **Fixed window:** key `rl:<gen>:<key>:<windowIndex>` (the index comes from the shared epoch).
  `GET` → if `>= max`, deny with `retryAfterMs = windowEnd - now`. Otherwise `INCR`, and on the first hit `PEXPIRE windowMs`.
- **Sliding log:** sorted set. `ZREMRANGEBYSCORE key -inf now-window` → `ZCARD`. If `>= max`, deny with
  `retryAfterMs = oldestScore + window - now` (`ZRANGE key 0 0 WITHSCORES`). Otherwise `ZADD now <unique member>` and `PEXPIRE window`.
  The member must be unique (two requests in the same ms): `now .. "-" .. INCR seq`.
- **Token bucket:** hash `{tokens, last}`. Refill `min(cap, tokens + elapsed × rate)`, take one if `>= 1`, otherwise
  `retryAfterMs = ceil((1 - tokens) / rate)`. Set `PEXPIRE` to the time it takes to refill fully, since a full bucket
  is the same as no key.
- `size()`: count the current generation's keys. Use `SCAN MATCH rl:<gen>:*`, or better, track the keys in a per-generation
  `SET` with a TTL. It's only used by `/api/stats`, so it doesn't need to be fast.

## Time: app clock vs. Redis `TIME`
Pass `now` from the app as a script argument. This keeps the fake-clock tests working, and the Day 1/scenario suites
can run unchanged against Redis. **Trade-off to explain:** with several nodes, app clocks can drift. Production
would use `redis.call("TIME")` inside the script so one clock decides. Here, all nodes are on one machine, so drift is zero.

## Tests (run when `REDIS_URL` is set)
- Run the **existing** shared-behaviour tests from `test/algorithms.test.ts` against each `RedisStore` (refactor them
  into a parametrised suite: memory and Redis).
- **Concurrency test:** 50 parallel `allow()` calls on one key with `max = 10` → exactly 10 allowed. This is the test
  that would fail without Lua.
- Run the Day 1 checks and scenario tests with `LIMITER_STORE=redis`.

## Acceptance criteria
- In the cluster with Redis, round-robin round 5 keyed by IP gives ~1× (same as single node).
- The concurrency test passes, and is shown failing for a deliberately non-atomic version (keep it as a named test or note).
