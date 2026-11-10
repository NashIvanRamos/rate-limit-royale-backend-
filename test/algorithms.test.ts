import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ALGORITHMS,
  createLimiter,
  FixedWindowLimiter,
  SlidingWindowLogLimiter,
  TokenBucketLimiter,
  type RateLimiter,
} from "../src/algorithms/index.js";

const MAX = 5;
const WINDOW = 1000;
/** Aligned to a fixed-window boundary (epoch 0), so "start of a window". */
const T0 = 1_000_000;

/** Fires `n` requests for `key` at time `now` and returns how many were allowed. */
function fire(limiter: RateLimiter, key: string, now: number, n: number): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (limiter.allow(key, now).allowed) allowed++;
  return allowed;
}

describe("shared limiter behaviour", () => {
  for (const algorithm of ALGORITHMS) {
    describe(algorithm, () => {
      const make = () => createLimiter(algorithm, { maxRequests: MAX, windowMs: WINDOW });

      test("factory returns the matching limiter", () => {
        assert.equal(make().name, algorithm);
      });

      test("allows maxRequests, then denies with retryAfterMs > 0", () => {
        const l = make();
        for (let i = 0; i < MAX; i++) {
          const d = l.allow("a", T0);
          assert.equal(d.allowed, true, `request ${i + 1}`);
          assert.equal(d.retryAfterMs, 0);
          assert.equal(d.remaining, MAX - i - 1);
        }
        const denied = l.allow("a", T0);
        assert.equal(denied.allowed, false);
        assert.ok(denied.retryAfterMs > 0);
        assert.equal(denied.remaining, 0);
      });

      test("keys are isolated", () => {
        const l = make();
        assert.equal(fire(l, "a", T0, MAX + 3), MAX);
        assert.equal(fire(l, "b", T0, MAX), MAX);
        assert.equal(l.size(), 2);
      });

      test("reset() clears all state", () => {
        const l = make();
        fire(l, "a", T0, MAX + 1);
        fire(l, "b", T0, 1);
        l.reset();
        assert.equal(l.size(), 0);
        assert.equal(fire(l, "a", T0, MAX), MAX);
      });

      test("allows again after waiting a full window", () => {
        const l = make();
        fire(l, "a", T0, MAX);
        assert.equal(l.allow("a", T0).allowed, false);
        assert.equal(fire(l, "a", T0 + WINDOW, MAX), MAX);
      });

      test("retryAfterMs is accurate: allowed exactly at now + retryAfterMs", () => {
        for (const offset of [0, 1, 250, 999]) {
          const l = make();
          const start = T0 + offset;
          fire(l, "a", start, MAX);
          // Probe at the same instant: for fixed window, start+δ could already be the next window.
          const probe = start;
          const d = l.allow("a", probe);
          assert.equal(d.allowed, false, `offset ${offset}`);
          assert.equal(l.allow("a", probe + d.retryAfterMs - 1).allowed, false, `offset ${offset}: too early`);
          assert.equal(l.allow("a", probe + d.retryAfterMs).allowed, true, `offset ${offset}: on time`);
        }
      });

      test("denied requests never consume budget", () => {
        const l = make();
        fire(l, "a", T0, MAX);
        // Hammer while denied.
        assert.equal(fire(l, "a", T0 + 10, 1000), 0);
        // Once a full window has passed since the accepted ones, the full budget is back.
        assert.equal(fire(l, "a", T0 + WINDOW, MAX), MAX);
      });
    });
  }
});

describe("fixed window", () => {
  test("edge exploit: N before the boundary + N after = 2N allowed", () => {
    const l = new FixedWindowLimiter({ maxRequests: MAX, windowMs: WINDOW });
    const boundary = T0 + WINDOW;
    assert.equal(fire(l, "a", boundary - 1, MAX), MAX);
    assert.equal(fire(l, "a", boundary, MAX), MAX);
    assert.equal(l.allow("a", boundary).allowed, false, "N+1th in the same window is denied");
  });

  test("windows align to epochMs", () => {
    const epoch = 123_456;
    const l = new FixedWindowLimiter({ maxRequests: MAX, windowMs: WINDOW, epochMs: epoch });
    fire(l, "a", epoch, MAX);
    const d = l.allow("a", epoch + 400);
    assert.equal(d.allowed, false);
    assert.equal(d.retryAfterMs, 600);
    assert.equal(l.allow("a", epoch + WINDOW).allowed, true);
  });
});

describe("sliding window log", () => {
  test("edge pattern is capped at N within any window", () => {
    const l = new SlidingWindowLogLimiter({ maxRequests: MAX, windowMs: WINDOW });
    const boundary = T0 + WINDOW;
    assert.equal(fire(l, "a", boundary - 1, MAX), MAX);
    assert.equal(fire(l, "a", boundary, MAX), 0);
    // Slots free up exactly windowMs after the original requests.
    assert.equal(fire(l, "a", boundary - 1 + WINDOW, MAX), MAX);
  });

  test("a denied request doesn't push back retryAfterMs", () => {
    const l = new SlidingWindowLogLimiter({ maxRequests: MAX, windowMs: WINDOW });
    fire(l, "a", T0, MAX);
    assert.equal(l.allow("a", T0 + 500).retryAfterMs, 500);
    assert.equal(l.allow("a", T0 + 700).retryAfterMs, 300);
  });

  test("invariant: never more than N accepted in any windowMs span", () => {
    const l = new SlidingWindowLogLimiter({ maxRequests: MAX, windowMs: WINDOW });
    const accepted: number[] = [];
    // Deterministic pseudo-random traffic.
    let seed = 42;
    let t = T0;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      t += seed % 37;
      if (l.allow("a", t).allowed) accepted.push(t);
    }
    for (let i = MAX; i < accepted.length; i++) {
      assert.ok(accepted[i]! - accepted[i - MAX]! >= WINDOW, `window violated at ${accepted[i]}`);
    }
  });

  test("peek decides without recording", () => {
    const l = new SlidingWindowLogLimiter({ maxRequests: MAX, windowMs: WINDOW });
    for (let i = 0; i < 20; i++) assert.equal(l.peek("a", T0).allowed, true);
    assert.equal(l.size(), 0);
    fire(l, "a", T0, MAX);
    assert.equal(l.peek("a", T0).allowed, false);
  });

  test("drops keys whose log empties", () => {
    const l = new SlidingWindowLogLimiter({ maxRequests: MAX, windowMs: WINDOW });
    fire(l, "a", T0, 2);
    assert.equal(l.size(), 1);
    l.peek("a", T0 + WINDOW);
    assert.equal(l.size(), 0);
  });
});

describe("token bucket", () => {
  const make = () => new TokenBucketLimiter({ maxRequests: MAX, windowMs: WINDOW });
  const refillInterval = WINDOW / MAX; // 200ms per token

  test("allows the initial burst, then exactly one per refill interval", () => {
    const l = make();
    assert.equal(fire(l, "a", T0, MAX + 1), MAX);
    assert.equal(fire(l, "a", T0 + refillInterval - 1, 1), 0);
    assert.equal(fire(l, "a", T0 + refillInterval, 3), 1);
    assert.equal(fire(l, "a", T0 + 2 * refillInterval, 3), 1);
  });

  test("never exceeds capacity after a long idle period", () => {
    const l = make();
    fire(l, "a", T0, MAX);
    assert.equal(fire(l, "a", T0 + 100 * WINDOW, MAX * 3), MAX);
  });

  test("sustained rate converges to N per window", () => {
    const l = make();
    const windows = 20;
    let allowed = 0;
    for (let t = T0; t < T0 + windows * WINDOW; t += 10) allowed += fire(l, "a", t, 1);
    // Initial burst (MAX) plus the refill (MAX per window).
    assert.ok(allowed >= windows * MAX && allowed <= windows * MAX + MAX, `allowed=${allowed}`);
  });

  test("tolerates a clock moving backwards", () => {
    const l = make();
    fire(l, "a", T0, MAX);
    assert.equal(l.allow("a", T0 - 5000).allowed, false);
    assert.equal(fire(l, "a", T0 + refillInterval, 1), 1);
  });
});

describe("option validation", () => {
  for (const algorithm of ALGORITHMS) {
    test(`${algorithm} rejects invalid options`, () => {
      assert.throws(() => createLimiter(algorithm, { maxRequests: 0, windowMs: WINDOW }), RangeError);
      assert.throws(() => createLimiter(algorithm, { maxRequests: 2.5, windowMs: WINDOW }), RangeError);
      assert.throws(() => createLimiter(algorithm, { maxRequests: MAX, windowMs: 0 }), RangeError);
      assert.throws(() => createLimiter(algorithm, { maxRequests: MAX, windowMs: Number.NaN }), RangeError);
    });
  }
});
