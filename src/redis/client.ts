/**
 * Redis client with the app's Lua scripts registered as commands (tasks2).
 *
 * Every multi-step read-decide-write runs as ONE Lua script, so it's atomic: no other client's command can run in
 * between. Keys are always passed in KEYS (never built inside a script), as Redis Cluster requires.
 */
import { Redis } from "ioredis";
import { SCRIPTS } from "./scripts.js";

export type ScriptName = keyof typeof SCRIPTS;

/** The Redis client plus one typed method per script. */
export type AppRedis = Redis & {
  [K in ScriptName]: (...args: Array<string | number>) => Promise<unknown>;
};

export function createRedis(url: string): AppRedis {
  const redis = new Redis(url, {
    // Fail fast instead of queueing forever when Redis is down (fail open/closed is decided in tasks2/06).
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    lazyConnect: false,
  }) as AppRedis;
  for (const [name, script] of Object.entries(SCRIPTS)) {
    redis.defineCommand(name, { numberOfKeys: script.keys, lua: script.lua });
  }
  // ioredis emits connection errors as events; unhandled ones would crash the process.
  redis.on("error", () => {});
  return redis;
}

/** Builds prefixed key names. */
export const keyspace = (prefix: string) => (...parts: Array<string | number>) => prefix + parts.join(":");
