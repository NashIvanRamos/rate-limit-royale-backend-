/**
 * Day 1 smoke test against an already running server, real clock.
 *
 *   npm run dev                      # in another terminal (DEMO_MODE=true, from .env)
 *   npm run smoke                    # BASE_URL defaults to http://localhost:3000
 *   BASE_URL=http://host:port npm run smoke
 *
 * Prints PASS/FAIL per case per algorithm and exits 1 on any failure. NOTE: this redeploys the defense
 * several times (resetting limiter state and stats) and leaves the server on the default defense.
 */
import { ALGORITHM_CHECK, ALGORITHMS, CASES, realClock, runDay1, type CheckResult } from "./day1Checks.js";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const DEFAULT_DEFENSE = { algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const dim = (s: string) => paint(2, s);

async function main(): Promise<number> {
  try {
    const health = await fetch(`${BASE_URL}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(red(`Server not reachable at ${BASE_URL}/api/health (${(err as Error).message}).`));
    console.error("Start it with `npm run dev` first, or set BASE_URL.");
    return 1;
  }

  console.log(`Day 1 smoke test → ${BASE_URL}  (maxRequests 5, windowMs 2000, keyBy user)\n`);
  const started = Date.now();
  const results: CheckResult[] = [];
  for (const algorithm of ALGORITHMS) {
    process.stdout.write(dim(`running ${algorithm}…\n`));
    results.push(...(await runDay1(algorithm, { baseUrl: BASE_URL, clock: realClock() })));
  }

  // Leave the server in its default state rather than on the last Day 1 config.
  await fetch(`${BASE_URL}/api/defense`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(DEFAULT_DEFENSE),
  });

  const nameWidth = Math.max(...CASES.map((c) => c.id.length + 2 + c.name.length));
  const cell = (s: string) => s.padEnd(9);
  console.log(`\n${"Case".padEnd(nameWidth)}  ${ALGORITHMS.map(cell).join("")}`);
  console.log("─".repeat(nameWidth + 2 + ALGORITHMS.length * 9));
  for (const c of CASES) {
    const cells = ALGORITHMS.map((algorithm) => {
      const r = results.find((x) => x.id === c.id && x.algorithm === algorithm);
      if (!r) return cell("—");
      return r.pass ? green(cell("PASS")) : red(cell("FAIL"));
    });
    console.log(`${`${c.id}. ${c.name}`.padEnd(nameWidth)}  ${cells.join("")}`);
  }
  console.log(dim(`\nCase 8: ${ALGORITHMS.map((a) => `${a}: ${ALGORITHM_CHECK[a]}`).join("\n        ")}`));

  const failures = results.filter((r) => !r.pass);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length === 0) {
    console.log(green(`\nAll ${results.length} checks passed in ${seconds}s.`));
    return 0;
  }
  console.log(red(`\n${failures.length} of ${results.length} checks failed (${seconds}s):`));
  for (const f of failures) console.log(`  [${f.algorithm}] case ${f.id}: ${f.detail}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(`Smoke test aborted: ${(err as Error).message}`));
    process.exit(1);
  },
);
