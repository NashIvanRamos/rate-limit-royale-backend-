/**
 * The runners' view of time (Day 1 checks and scenario replays). "Server time" is what the server's limiter sees.
 * Real clock: Date.now() plus an offset calibrated from the deploy response. Fake clock: the test's clock.
 */
export interface Clock {
  now(): number;
  waitUntil(serverTimeMs: number): Promise<void>;
  /** Added to every wait. Absorbs network latency on a real clock, 0 on a fake one. */
  readonly slackMs: number;
  calibrate?(serverTimeMs: number, sentAtMs: number, receivedAtMs: number): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function realClock(slackMs = 30): Clock {
  let offset = 0;
  return {
    slackMs,
    now: () => Date.now() + offset,
    async waitUntil(t) {
      const delay = t - (Date.now() + offset);
      if (delay > 0) await sleep(delay);
    },
    calibrate(serverTime, sentAt, receivedAt) {
      offset = serverTime - (sentAt + receivedAt) / 2;
    },
  };
}
