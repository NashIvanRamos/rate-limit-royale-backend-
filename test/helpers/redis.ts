/**
 * A throwaway redis-server for tests (tasks2). Returns null when redis-server isn't installed, so suites can skip.
 * No persistence; killed on stop. Each suite should use its own REDIS_PREFIX so tests can share one server.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";

export const hasRedis = spawnSync("which", ["redis-server"]).status === 0;
export const SKIP_REDIS = hasRedis ? false : "redis-server not installed (brew install redis)";

export interface TestRedis {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], {
    stdio: "ignore",
  });
  const url = `redis://127.0.0.1:${port}`;
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on("error", () => {});
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await probe.connect();
      await probe.ping();
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`redis-server didn't start on ${port}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  probe.disconnect();
  return {
    url,
    port,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** A fresh key prefix per app/suite, so tests sharing one Redis never see each other's keys. */
export const uniquePrefix = () => `t${randomBytes(4).toString("hex")}:`;
