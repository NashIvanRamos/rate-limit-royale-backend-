import type { Clock } from "../../scripts/clock.js";
import { fakeClock } from "./server.js";

/**
 * A fake clock for the HTTP runners (Day 1 checks, replays). Pass `now` to startServer so the server's
 * limiter sees the same time. Waiting just moves the clock forward.
 */
export function fakeRunnerClock(start?: number): { clock: Clock; now: () => number } {
  const fc = fakeClock(start);
  return {
    now: fc.now,
    clock: {
      slackMs: 0,
      now: fc.now,
      async waitUntil(t) {
        if (t > fc.now()) fc.set(t);
      },
    },
  };
}
