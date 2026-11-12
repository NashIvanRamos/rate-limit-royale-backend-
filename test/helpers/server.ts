import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadEnv, type Env } from "../../src/config/env.js";

export const TEST_SECRET = "test-secret-that-is-at-least-32-characters-long";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ JWT_SECRET: TEST_SECRET, DEMO_MODE: "true", ...overrides });
}

export interface TestServer {
  app: Express;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Starts a fresh app on an ephemeral port. */
export async function startServer(env: Env = testEnv(), deps: AppDeps = {}): Promise<TestServer> {
  const app = createApp(env, deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await app.locals.redis?.quit();
    },
  };
}

/** A manually advanced clock for deterministic tests. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}
