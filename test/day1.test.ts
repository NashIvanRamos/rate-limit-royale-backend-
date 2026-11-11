/**
 * Day 1 verification (design doc §10 Day 1, §12). Runs the same checks as `npm run smoke`
 * (scripts/day1Checks.ts) over HTTP against a fresh app per algorithm.
 *
 * Fake clock: deterministic and instant, including the boundary and refill timing.
 * Real clock: one pass for the token bucket (short waits), to prove the default Date.now wiring.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ALGORITHMS, CASES, realClock, runDay1, type Algorithm, type CheckResult } from "../scripts/day1Checks.js";
import { fakeRunnerClock } from "./helpers/clock.js";
import { startServer, testEnv } from "./helpers/server.js";

function assertAllCases(results: CheckResult[], algorithm: Algorithm) {
  assert.deepEqual(
    results.map((r) => r.id),
    CASES.map((c) => c.id),
    "every case ran exactly once",
  );
  const failures = results.filter((r) => !r.pass).map((r) => `case ${r.id}: ${r.detail}`);
  assert.deepEqual(failures, [], `[${algorithm}] failing cases`);
}

describe("Day 1 checks (fake clock)", () => {
  for (const algorithm of ALGORITHMS) {
    test(algorithm, async (t) => {
      const { clock, now } = fakeRunnerClock();
      const server = await startServer(testEnv(), { now });
      try {
        const results = await runDay1(algorithm, { baseUrl: server.baseUrl, clock });
        // One subtest per case, so a failure names the exact case.
        for (const r of results) {
          const name = CASES.find((c) => c.id === r.id)!.name;
          await t.test(`${r.id}. ${name}`, () => assert.ok(r.pass, r.detail));
        }
        assertAllCases(results, algorithm);
      } finally {
        await server.close();
      }
    });
  }
});

describe("Day 1 checks (real clock)", () => {
  test("token bucket, end to end with Date.now", async () => {
    const server = await startServer(testEnv());
    try {
      assertAllCases(await runDay1("token", { baseUrl: server.baseUrl, clock: realClock() }), "token");
    } finally {
      await server.close();
    }
  });
});

describe("Day 1 checks catch regressions", () => {
  test("case 4 fails with a clear hint when DEMO_MODE=false", async () => {
    const { clock, now } = fakeRunnerClock();
    const server = await startServer(testEnv({ DEMO_MODE: "false" }), { now });
    try {
      const results = await runDay1("fixed", { baseUrl: server.baseUrl, clock });
      const case4 = results.find((r) => r.id === "4")!;
      assert.equal(case4.pass, false);
      assert.match(case4.detail, /DEMO_MODE=true/);
      assert.ok(results.filter((r) => r.id !== "4").every((r) => r.pass));
    } finally {
      await server.close();
    }
  });
});
