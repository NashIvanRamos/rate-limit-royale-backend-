/**
 * The distributed experiment (tasks2/07): every combination of load balancing × store, measured.
 *
 *   npm run experiment                      # full matrix, ~3 minutes
 *   npm run experiment -- --rounds 5        # only round 5 (faster)
 *   npm run experiment -- --write           # also save the table to docs/experiment-results.md
 *
 * For each of { round-robin, sticky } × { memory, redis } it starts a fresh cluster (NGINX + 3 nodes [+ Redis]),
 * replays the rounds through the load balancer, and records what got through. Then the sticky failure case: kill the
 * node serving the attacker's IP halfway through round 5 and see whether the attacker gets a fresh budget.
 *
 * Uses the default cluster ports (:8080, :3001-3003, :6379), so stop `npm run cluster` first.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_DEFENSE, type DefenseConfig } from "../src/config/defense.js";
import { ATTACKER_IP, getScenario } from "../src/scenarios/rounds.js";
import { realClock } from "./clock.js";
import { startCluster, type Cluster, type LbMode, type StoreMode } from "./cluster.js";
import { replay, type ReplayResult } from "./replayEngine.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMBOS: Array<{ lb: LbMode; store: StoreMode }> = [
  { lb: "round-robin", store: "memory" },
  { lb: "round-robin", store: "redis" },
  { lb: "sticky", store: "memory" },
  { lb: "sticky", store: "redis" },
];

interface Row {
  lb: LbMode;
  store: StoreMode;
  /** Set for the tasks2/09 row: a Redis-backed cluster with this round deployed as `limiterStore: "memory"`. */
  roundStore?: "memory";
  round5?: ReplayResult;
  round4?: ReplayResult;
  round1?: ReplayResult;
  killed?: { result: ReplayResult; node: string };
}

const log = (s: string) => process.stdout.write(`${s}\n`);

async function run(cluster: Cluster, round: number, config: DefenseConfig, extra: Partial<Parameters<typeof replay>[0]> = {}) {
  return replay({
    baseUrl: cluster.lbUrl,
    controlUrls: cluster.nodeUrls,
    scenario: getScenario(round),
    config,
    clock: realClock(),
    leadMs: 100,
    ...extra,
  });
}

/** Which node the load balancer sends a client IP to right now. */
async function nodeFor(cluster: Cluster, ip: string): Promise<number> {
  const res = await fetch(`${cluster.lbUrl}/api/health`, { headers: { "X-Forwarded-For": ip } });
  await res.body?.cancel();
  return Number(res.headers.get("x-node-id")!.replace("node-", "")) - 1;
}

const passed = (r?: ReplayResult) => (r ? String(r.tally.attackPassed) : "–");
const lockout = (r?: ReplayResult) => (r ? String(r.records.filter((x) => x.path === "/api/login" && x.status === 401).length) : "–");
const legit = (...rs: Array<ReplayResult | undefined>) => String(rs.reduce((n, r) => n + (r?.tally.legitBlocks ?? 0), 0));
const statsOk = (...rs: Array<ReplayResult | undefined>) => (rs.every((r) => !r || r.statsCheck.matches) ? "✓" : "✗");

function table(rows: Row[], rounds: number[], config: DefenseConfig): string {
  const cfg = `${config.algorithm}, ${config.maxRequests} per ${config.windowMs / 1000}s, key by ${config.keyBy}`;
  const lines = [
    `Defense: ${cfg}. Single-node baseline: round 5 → 13, round 1 → 12, login lockout after 5.`,
    "",
    "| Load balancing | Store | Round 5: attacker through | Round 1: attacker through | Round 4: failed logins before lockout | Legit blocks | Stats match |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.lb} | ${r.roundStore ? `${r.store}, round toggled to memory` : r.store} | ${rounds.includes(5) ? passed(r.round5) : "–"} | ${rounds.includes(1) ? passed(r.round1) : "–"} | ${rounds.includes(4) ? lockout(r.round4) : "–"} | ${legit(r.round5, r.round1, r.round4)} | ${statsOk(r.round5, r.round1, r.round4)} |`,
    );
  }
  const kills = rows.filter((r) => r.killed);
  if (kills.length) {
    lines.push("", "**Sticky, attacker's node killed halfway through round 5:**", "", "| Store | Attacker through | Normal sticky run | Node killed |", "|---|---|---|---|");
    for (const r of kills) lines.push(`| ${r.store} | **${passed(r.killed!.result)}** | ${passed(r.round5)} | ${r.killed!.node} |`);
    lines.push("", "(In memory mode the killed node's stats die with it, so that run can't be cross-checked; that is the point.)");
  }
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      rounds: { type: "string", default: "5,4,1" },
      write: { type: "boolean", default: false },
      "no-kill": { type: "boolean", default: false },
    },
  });
  const rounds = values.rounds.split(",").map((s) => Number(s.trim()));
  if (rounds.some((r) => ![1, 4, 5].includes(r))) throw new Error("--rounds takes a comma list of 1, 4, 5");
  const config: DefenseConfig = { ...DEFAULT_DEFENSE };

  const rows: Row[] = [];
  const started = Date.now();
  for (const { lb, store } of COMBOS) {
    log(`\n▶ ${lb} + ${store}`);
    const cluster = await startCluster({ lb, store });
    const row: Row = { lb, store };
    try {
      for (const round of rounds) {
        const r = await run(cluster, round, config);
        log(`  round ${round}: attacker ${r.tally.attackPassed}/${r.tally.attackTotal} through, legit blocks ${r.tally.legitBlocks}, stats ${r.statsCheck.matches ? "match" : "MISMATCH"}`);
        if (round === 5) row.round5 = r;
        if (round === 4) row.round4 = r;
        if (round === 1) row.round1 = r;
      }

      // tasks2/09: same Redis-backed cluster, but the round deployed with limiterStore "memory" (the game's toggle).
      if (lb === "round-robin" && store === "redis") {
        const toggled: Row = { lb, store, roundStore: "memory" };
        const memoryRound = { ...config, limiterStore: "memory" as const };
        for (const round of rounds) {
          const r = await run(cluster, round, memoryRound);
          log(`  round ${round} with limiterStore memory: attacker ${r.tally.attackPassed}/${r.tally.attackTotal} through, stats ${r.statsCheck.matches ? "match" : "MISMATCH"}`);
          if (round === 5) toggled.round5 = r;
          if (round === 4) toggled.round4 = r;
          if (round === 1) toggled.round1 = r;
        }
        rows.push(row, toggled);
        continue;
      }

      if (lb === "sticky" && rounds.includes(5) && !values["no-kill"]) {
        const victim = await nodeFor(cluster, ATTACKER_IP);
        const name = `node-${victim + 1}`;
        log(`  round 5 again, killing ${name} (serves ${ATTACKER_IP}) halfway…`);
        let timer: NodeJS.Timeout | undefined;
        const result = await run(cluster, 5, config, {
          tolerateDeadNodes: true,
          onFireStart: () => {
            timer = setTimeout(() => void cluster.killNode(victim), getScenario(5).durationMs / 2);
          },
        });
        clearTimeout(timer);
        log(`  killed run: attacker ${result.tally.attackPassed}/${result.tally.attackTotal} through (errors ${result.tally.errors})`);
        row.killed = { result, node: name };
      }
    } finally {
      await cluster.stop();
    }
    rows.push(row);
  }

  const md = table(rows, rounds, config);
  log(`\n${md}\n\nDone in ${Math.round((Date.now() - started) / 1000)}s.`);
  if (values.write) {
    const file = join(ROOT, "docs/experiment-results.md");
    writeFileSync(file, `# Distributed experiment results\n\nGenerated by \`npm run experiment\` on ${new Date().toISOString().slice(0, 10)}.\n\n${md}\n`);
    log(`Saved ${file}`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
