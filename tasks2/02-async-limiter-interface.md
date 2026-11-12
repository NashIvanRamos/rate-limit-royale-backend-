# 02: Async limiter interface

## Goal
Redis calls are async. `RateLimiter.allow()` is synchronous today. Make the request path async **without** touching
the algorithm classes or their 50+ fake-clock unit tests.

## Design
- New interface in `src/algorithms/types.ts`:
  ```ts
  interface LimiterStore {
    allow(key: string, now: number): Promise<LimitDecision>;
    size(): Promise<number>;
  }
  ```
- `MemoryStore`: wraps an existing in-memory `RateLimiter` (`Promise.resolve(limiter.allow(...))`). Algorithm classes
  are unchanged.
- `RedisStore` arrives in task 04.
- `rateLimit` middleware becomes `async (req, res, next) => { const decision = await store.allow(...) }`. Express 5
  forwards rejected promises to the error handler, so a Redis error becomes a 500 until task 06 decides open/closed.
- `DefenseState` exposes `store` instead of `limiter`. `/api/stats` awaits `store.size()`.

## Tests
- The existing pipeline, Day 1 and scenario suites pass unchanged against `MemoryStore` (they run over HTTP, so the
  async change is invisible to them).
- A test where `store.allow` rejects → 500 JSON with no stack trace (placeholder until 06).

## Acceptance criteria
- `npm test` is green with no behaviour change. This is a pure refactor and should be its own PR.
