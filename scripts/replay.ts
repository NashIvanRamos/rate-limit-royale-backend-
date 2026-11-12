/**
 * Replays a round against a running server in real time, the way the browser does, and cross-checks the
 * result against GET /api/stats.
 *
 *   npm run replay -- --round 5 --keyBy both          # the keying comparison
 *   npm run replay -- --round 2 --algorithm fixed --window 2000
 *   npm run replay -- --round all --algorithm sliding
 *
 * Options: --round 1..5|all (default all), --algorithm fixed|sliding|token, --max 5..100, --window 1000..60000,
 *          --keyBy ip|user|both. Defaults are the server's default defense (fixed, 10 per 10000ms, ip).
 *
 * Per-round store (tasks2/09): `--limiter-store memory|redis` (Redis-backed servers only; omitted = server default).
 * Multi-node (tasks2): `--cluster` targets `npm run cluster` (load balancer :8080, nodes :3001-3003).
 *          `--nodes url1,url2,…` lists the nodes explicitly. Deploys and stats go to every node directly, attack
 *          traffic goes through BASE_URL (the load balancer), and the per-node split is printed.
 * BASE_URL defaults to http://localhost:3000. Needs DEMO_MODE=true (round 4's expired token).
 * Redeploys the defense for each run and leaves the server on the default defense.
 * Exits 1 if any replay disagrees with /api/stats or hits network errors.
 */
import { parseArgs } from "node:util";
import { DEFAULT_DEFENSE, validateDefenseConfig, type DefenseConfig, type KeyBy } from "../src/config/defense.js";
import { SCENARIOS, getScenario } from "../src/scenarios/rounds.js";
import { realClock } from "./clock.js";
import { replay, ReplayError, type ReplayResult } from "./replayEngine.js";

const CLUSTER_LB = "http://127.0.0.1:8080";
const CLUSTER_NODES = ["http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://127.0.0.1:3003"];

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const bold = (s: string) => paint(1, s);
const dim = (s: string) => paint(2, s);

function usage(message: string): never {
  console.error(red(message));
  console.error("Usage: npm run replay -- [--round 1..5|all] [--algorithm fixed|sliding|token] [--max N] [--window MS] [--keyBy ip|user|both] [--limiter-store memory|redis] [--cluster]");
  process.exit(2);
}

function parse() {
  const { values } = parseArgs({
    options: {
      round: { type: "string", default: "all" },
      algorithm: { type: "string", default: DEFAULT_DEFENSE.algorithm },
      max: { type: "string", default: String(DEFAULT_DEFENSE.maxRequests) },
      window: { type: "string", default: String(DEFAULT_DEFENSE.windowMs) },
      keyBy: { type: "string", default: DEFAULT_DEFENSE.keyBy },
      cluster: { type: "boolean", default: false },
      "limiter-store": { type: "string" },
      nodes: { type: "string" },
    },
  });

  const baseUrl = (process.env.BASE_URL ?? (values.cluster ? CLUSTER_LB : "http://localhost:3000")).replace(/\/+$/, "");
  const nodeUrls = values.nodes
    ? values.nodes.split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean)
    : values.cluster
      ? CLUSTER_NODES
      : [];

  const rounds = values.round === "all" ? SCENARIOS.map((s) => s.id) : [Number(values.round)];
  if (rounds.some((r) => !SCENARIOS.some((s) => s.id === r))) usage(`--round must be 1–${SCENARIOS.length} or "all"`);

  const keyBys: KeyBy[] = values.keyBy === "both" ? ["user", "ip"] : [values.keyBy as KeyBy];
  const configs = keyBys.map((keyBy) => {
    const result = validateDefenseConfig(
      {
        algorithm: values.algorithm,
        maxRequests: Number(values.max),
        windowMs: Number(values.window),
        keyBy,
        ...(values["limiter-store"] ? { limiterStore: values["limiter-store"] } : {}),
      },
      ["memory", "redis"], // the server does the real availability check
    );
    if (!result.ok) usage(`Invalid config: ${result.issues.map((i) => `${i.field} ${i.message}`).join(", ")}`);
    // Only send limiterStore when asked, so the server applies its own default (tasks2/09).
    const { limiterStore, ...rest } = result.config;
    return values["limiter-store"] ? { ...rest, limiterStore } : rest;
  });
  return { rounds, configs, baseUrl, nodeUrls };
}

const describeConfig = (c: DefenseConfig) =>
  `${c.algorithm} · ${c.maxRequests} per ${c.windowMs}ms · key by ${c.keyBy}${c.limiterStore ? ` · limiter store ${c.limiterStore}` : ""}`;

function print(r: ReplayResult) {
  const t = r.tally;
  const s = r.score;
  console.log(`\n${bold(`Round ${r.scenario.id} · ${r.scenario.name}`)}   ${dim(`[${describeConfig(r.config)}]`)}`);
  console.log(
    `  requests ${t.total} · accepted ${t.accepted} · blocked ${t.blocked} · rejected auth ${t.rejectedAuth}` +
      `${t.errors ? red(` · errors ${t.errors}`) : ""} · avg latency ${t.avgLatencyMs.toFixed(1)}ms`,
  );
  console.log(`  attack: ${t.attackTotal} sent, ${t.attackPassed} passed, ${t.attackStopped} stopped`);
  console.log(`  legit:  ${t.legitBlocks} blocked (429), ${t.legitExpired} expired-token 401s (not penalised)`);
  const verdict = s.cleared ? green("cleared") : red("not cleared");
  console.log(`  score:  ${s.xpEarned} XP, ${verdict}  ${dim(`(allowance ${s.allowance.toFixed(1)}, containment ${s.containment.toFixed(2)})`)}`);

  const res = r.stats.resource;
  const check = r.statsCheck.matches ? green("✓ matches") : red("✗ MISMATCH");
  console.log(`  server confirms (/api/stats): 200 × ${res.s200}, 429 × ${res.s429}, 401 × ${res.s401}  ${check}`);
  for (const m of r.statsCheck.mismatches) console.log(red(`    ${m}`));
  const logins = r.records.filter((x) => x.path === "/api/login");
  if (logins.length > 0) {
    const n = (code: number) => logins.filter((x) => x.status === code).length;
    console.log(`  login:  ${logins.length} attempts → ${n(401)} × 401 before lockout, ${n(429)} × 429`);
  }
  const split = Object.entries(r.nodeSplit).sort(([a], [b]) => a.localeCompare(b));
  if (split.length > 1) console.log(`  served by: ${split.map(([id, n]) => `${id} ${n}`).join(", ")}`);
  const top = r.stats.topKeys.slice(0, 3).map((k) => `${k.key} (${k.allowed}/${k.requests})`);
  console.log(dim(`  limiter keys: ${r.stats.trackedKeys}${top.length ? ` · top: ${top.join(", ")}` : ""}`));
}

async function main(): Promise<number> {
  const { rounds, configs, baseUrl: BASE_URL, nodeUrls } = parse();
  const controlUrls = nodeUrls.length > 0 ? nodeUrls : [BASE_URL];
  if (nodeUrls.length > 0) console.log(dim(`multi-node: traffic → ${BASE_URL}, deploy/stats → ${nodeUrls.join(", ")}`));
  try {
    const health = await fetch(`${BASE_URL}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(red(`Server not reachable at ${BASE_URL} (${(err as Error).message}). Start it with \`npm run dev\`.`));
    return 1;
  }

  let ok = true;
  for (const round of rounds) {
    const scenario = getScenario(round);
    const results: ReplayResult[] = [];
    for (const config of configs) {
      console.log(dim(`\nreplaying round ${round} [${describeConfig(config)}] (~${Math.round(scenario.durationMs / 1000)}s)…`));
      const r = await replay({ baseUrl: BASE_URL, controlUrls, scenario, config, clock: realClock(), leadMs: 100 });
      print(r);
      ok &&= r.statsCheck.matches && r.tally.errors === 0;
      results.push(r);
    }
    if (results.length === 2) {
      const [user, ip] = results as [ReplayResult, ReplayResult];
      const ratio = ip.tally.attackPassed === 0 ? "∞" : (user.tally.attackPassed / ip.tally.attackPassed).toFixed(1);
      console.log(
        bold(`\n  Keying: attacker got ${user.tally.attackPassed} through keyed by user vs ${ip.tally.attackPassed} keyed by IP (${ratio}×)`),
      );
    }
  }

  await Promise.all(
    controlUrls.map((url) =>
      fetch(`${url}/api/defense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DEFAULT_DEFENSE),
      }),
    ),
  );
  console.log(ok ? green("\nAll replays match the server's stats.") : red("\nSome replays failed. See above."));
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(err instanceof ReplayError ? err.message : `Replay aborted: ${(err as Error).stack}`));
    process.exit(1);
  },
);
