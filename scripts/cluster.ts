/**
 * Local cluster (tasks2/00): NGINX load balancer in front of N app nodes, all on loopback.
 *
 *   npm run cluster                      # round robin, 3 nodes, LB on :8080, nodes on :3001-3003
 *   npm run cluster -- --lb sticky       # hash on the client's X-Forwarded-For
 *   npm run cluster -- --store redis     # shared state: also starts redis-server on :6379 (no persistence)
 *   npm run cluster -- --nodes 5 --lb-port 9090 --base-port 4001
 *
 * Ctrl+C stops everything. Also importable (`startCluster`) for tests and the experiment script.
 * Each node is a plain `node --import tsx src/server.ts` reading the same .env; only PORT and NODE_ID differ.
 * --store memory (default): state per node. --store redis: config, stats (and from tasks2/04 counters) shared.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type LbMode = "round-robin" | "sticky";
export const LB_MODES: readonly LbMode[] = ["round-robin", "sticky"];
export type StoreMode = "memory" | "redis";
export const STORE_MODES: readonly StoreMode[] = ["memory", "redis"];

export interface ClusterOptions {
  nodes?: number;
  basePort?: number;
  lbPort?: number;
  lb?: LbMode;
  store?: StoreMode;
  /** Redis port when store is "redis". A fresh redis-server is started there and stopped with the cluster. */
  redisPort?: number;
  /** Extra env for every node (merged over process.env). */
  env?: Record<string, string>;
  /** Called with each prefixed output line. Default: drop it. */
  log?: (line: string) => void;
}

export interface Cluster {
  lbUrl: string;
  nodeUrls: string[];
  lb: LbMode;
  store: StoreMode;
  redisUrl?: string;
  /** Kill one node (for the sticky failure experiment). Resolves when it has exited. */
  killNode(index: number): Promise<void>;
  stop(): Promise<void>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "infra/nginx/nginx.conf.template");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nginxBinary(): string {
  const found = spawnSync("which", ["nginx"], { encoding: "utf8" }).stdout.trim();
  if (!found) throw new Error("nginx not found. Install it with `brew install nginx`.");
  return found;
}

export function renderNginxConf(opts: { lbPort: number; ports: number[]; lb: LbMode }): string {
  return readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{LISTEN}}", `127.0.0.1:${opts.lbPort}`)
    .replaceAll("{{BALANCE}}", opts.lb === "sticky" ? "hash $http_x_forwarded_for consistent;" : "# round robin (default)")
    .replaceAll("{{SERVERS}}", opts.ports.map((p) => `    server 127.0.0.1:${p} max_fails=1 fail_timeout=5s;`).join("\n"));
}

/** Pipes a child's output line by line with a `[name]` prefix. */
function pipe(child: ChildProcess, name: string, log: (line: string) => void) {
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) if (line.trim()) log(`[${name}] ${line}`);
    });
  }
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(100);
  }
  throw new Error(`${url} not healthy after ${timeoutMs}ms (${last})`);
}

async function waitRedis(port: number, timeoutMs: number): Promise<void> {
  const { Socket } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = new Socket();
      s.once("connect", () => s.write("PING\r\n"));
      s.once("data", (d) => {
        s.destroy();
        resolve(d.toString().startsWith("+PONG"));
      });
      s.once("error", () => resolve(false));
      s.connect(port, "127.0.0.1");
    });
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`redis-server not answering on ${port} after ${timeoutMs}ms`);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once("exit", () => r()));
}

export async function startCluster(opts: ClusterOptions = {}): Promise<Cluster> {
  const n = opts.nodes ?? 3;
  const basePort = opts.basePort ?? 3001;
  const lbPort = opts.lbPort ?? 8080;
  const lb = opts.lb ?? "round-robin";
  const store = opts.store ?? "memory";
  const redisPort = opts.redisPort ?? 6379;
  const redisUrl = store === "redis" ? `redis://127.0.0.1:${redisPort}` : undefined;
  const log = opts.log ?? (() => {});
  const ports = Array.from({ length: n }, (_, i) => basePort + i);

  const children: ChildProcess[] = [];
  const nodes: ChildProcess[] = [];
  let stopping = false;

  const stop = async () => {
    stopping = true;
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
    await Promise.race([Promise.all(children.map(exited)), sleep(3_000)]);
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  };

  try {
    // Redis (fresh, empty, no persistence) before the nodes, so they can connect on boot.
    if (store === "redis") {
      const redis = spawn("redis-server", ["--port", String(redisPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      redis.on("error", (err) => log(`[redis] ${err.message}. Install it with \`brew install redis\`.`));
      pipe(redis, "redis", () => {}); // very chatty on boot; errors surface through the nodes
      redis.on("exit", (code, signal) => {
        if (!stopping) log(`[redis] exited (${signal ?? code}). Is port ${redisPort} already in use?`);
      });
      children.push(redis);
      await waitRedis(redisPort, 5_000);
    }

    // Nodes.
    ports.forEach((port, i) => {
      const nodeId = `node-${i + 1}`;
      const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          ...opts.env,
          PORT: String(port),
          NODE_ID: nodeId,
          LIMITER_STORE: store,
          ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      pipe(child, nodeId, log);
      child.on("exit", (code, signal) => {
        if (!stopping) log(`[${nodeId}] exited (${signal ?? code})`);
      });
      children.push(child);
      nodes.push(child);
    });
    await Promise.all(ports.map((p) => waitHealthy(`http://127.0.0.1:${p}`, 15_000)));

    // Load balancer.
    const runDir = join(ROOT, "infra/nginx/run", String(lbPort));
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(join(runDir, "tmp"), { recursive: true });
    writeFileSync(join(runDir, "nginx.conf"), renderNginxConf({ lbPort, ports, lb }));
    const nginx = nginxBinary();
    const nginxArgs = ["-p", runDir, "-e", join(runDir, "error.log"), "-c", "nginx.conf"];
    const check = spawnSync(nginx, [...nginxArgs, "-t"], { encoding: "utf8" });
    if (check.status !== 0) throw new Error(`nginx config test failed:\n${check.stderr}`);

    const proxy = spawn(nginx, [...nginxArgs, "-g", "daemon off;"], { stdio: ["ignore", "pipe", "pipe"] });
    pipe(proxy, "nginx", log);
    proxy.on("exit", (code, signal) => {
      if (!stopping) log(`[nginx] exited (${signal ?? code}). Is port ${lbPort} already in use? See ${runDir}/error.log`);
    });
    children.push(proxy);
    await waitHealthy(`http://127.0.0.1:${lbPort}`, 5_000);
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    lbUrl: `http://127.0.0.1:${lbPort}`,
    nodeUrls: ports.map((p) => `http://127.0.0.1:${p}`),
    lb,
    store,
    redisUrl,
    async killNode(index) {
      const node = nodes[index];
      if (!node) throw new RangeError(`no node ${index}`);
      node.kill("SIGKILL");
      await exited(node);
    },
    stop,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      lb: { type: "string", default: "round-robin" },
      store: { type: "string", default: "memory" },
      "redis-port": { type: "string", default: "6379" },
      nodes: { type: "string", default: "3" },
      "base-port": { type: "string", default: "3001" },
      "lb-port": { type: "string", default: "8080" },
    },
  });
  if (!LB_MODES.includes(values.lb as LbMode)) {
    console.error(`--lb must be one of: ${LB_MODES.join(", ")}`);
    process.exit(2);
  }
  if (!STORE_MODES.includes(values.store as StoreMode)) {
    console.error(`--store must be one of: ${STORE_MODES.join(", ")}`);
    process.exit(2);
  }
  const nodes = Number(values.nodes);
  if (!Number.isInteger(nodes) || nodes < 1 || nodes > 9) {
    console.error("--nodes must be 1–9");
    process.exit(2);
  }

  console.log(`Starting ${nodes} nodes + NGINX (${values.lb}, store ${values.store})…`);
  const cluster = await startCluster({
    nodes,
    lb: values.lb as LbMode,
    basePort: Number(values["base-port"]),
    lbPort: Number(values["lb-port"]),
    store: values.store as StoreMode,
    redisPort: Number(values["redis-port"]),
    log: (line) => console.log(line),
  });
  console.log(`\nCluster up. Load balancer: ${cluster.lbUrl}  (${cluster.lb}, store ${cluster.store})`);
  if (cluster.redisUrl) console.log(`  redis:  ${cluster.redisUrl}`);
  cluster.nodeUrls.forEach((u, i) => console.log(`  node-${i + 1}: ${u}`));
  console.log(`\nTry: npm run replay -- --cluster --round 5\nCtrl+C to stop.\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nStopping cluster…");
    await cluster.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
