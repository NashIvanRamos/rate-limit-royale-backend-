# 01: Limiter interface and algorithms

## Goal
Three interchangeable rate limiters behind one interface, pure and clock-injected, so their
trade-offs (doc §5, §11) can be demonstrated and unit-tested deterministically.

## Interface (`src/algorithms/types.ts`)
```ts
export interface LimitDecision {
  allowed: boolean;
  retryAfterMs: number;   // 0 when allowed
  remaining: number;      // best-effort, for headers/debug
}
export interface RateLimiter {
  readonly name: "fixed" | "sliding" | "token";
  allow(key: string, now: number): LimitDecision;
  reset(): void;
  size(): number;         // number of tracked keys (debug/stats, memory talking point)
}
export interface LimiterOptions { maxRequests: number; windowMs: number; epochMs?: number }
```
`allow` is synchronous and never calls `Date.now()`.

## Algorithms

### Fixed window (`fixedWindow.ts`)
- Windows are aligned to `epochMs` (deploy time, default 0): `index = floor((now - epoch) / windowMs)`.
- State: `Map<key, { index, count }>`. A new index resets count.
- Deny when `count >= maxRequests`. `retryAfterMs = epoch + (index + 1) * windowMs - now`.
- Expected weakness: N requests at end of window k plus N at start of k+1 are all allowed (2N burst).

### Sliding window log (`slidingWindowLog.ts`)
- State: `Map<key, number[]>` timestamps, ascending.
- On each call, drop timestamps `<= now - windowMs` (shift from front).
- Deny when `log.length >= maxRequests`. `retryAfterMs = log[0] + windowMs - now`.
- **Denied requests are not logged.** Otherwise an attacker extends their own lockout forever and memory grows unbounded.
- Delete the key when the log empties (keeps `size()` honest).

### Token bucket (`tokenBucket.ts`)
- `capacity = maxRequests`, `refillPerMs = maxRequests / windowMs` (same long-run average as the others).
- State: `Map<key, { tokens, last }>`. A new key starts full. Lazy refill:
  `tokens = min(capacity, tokens + (now - last) * refillPerMs)`.
- Allow when `tokens >= 1` and subtract 1. Otherwise `retryAfterMs = ceil((1 - tokens) / refillPerMs)`.
- Guard against `now < last` (clock skew in tests) by treating elapsed as 0.

### Factory (`index.ts`)
`createLimiter(algorithm, options): RateLimiter`, exhaustive switch.

## Tests (`test/algorithms.test.ts`, fake clock)
Shared behaviour, run for all three:
- First `maxRequests` calls allowed, next denied with `retryAfterMs > 0`.
- Keys are isolated (key A exhausted doesn't affect key B).
- `reset()` clears all state and `size()` returns 0.
- After waiting the full window, requests are allowed again.

Algorithm-specific:
- **Fixed:** N at `boundary-1ms` and N at `boundary` are all allowed (2N). The N+1th in a window is denied.
- **Sliding:** the same edge pattern allows only N within any `windowMs` span. A denied request doesn't push back `retryAfterMs`.
- **Token:** initial burst of N allowed. After `windowMs / N` ms exactly 1 more is allowed. Sustained rate converges to N per window.
- `retryAfterMs` is accurate: calling again at `now + retryAfterMs` is allowed.

## Acceptance criteria
- All tests pass. No limiter imports Express.
- Each file has a short header comment stating its trade-off (it gets reused in the README).

## Notes
- Stale-key sweeping isn't required, since `/api/defense` resets state per round. Mention it in the README as a production concern.
