/**
 * Single source of truth for configuration. Nothing else in the app reads process.env.
 * Validation happens once at boot; invalid config throws so the server never starts half-configured.
 */

export type TrustProxySetting = boolean | string | number;

export interface Env {
  readonly PORT: number;
  readonly JWT_SECRET: string;
  readonly TRUST_PROXY: TrustProxySetting;
  readonly DEMO_MODE: boolean;
  readonly CORS_ORIGIN: string;
  /** Identifies this process in a multi-node setup (tasks2). Echoed in X-Node-Id, /api/health and /api/stats. */
  readonly NODE_ID: string;
  /** Where round state (defense config, limiter counters, stats) lives. "redis" shares it across nodes (tasks2). */
  readonly LIMITER_STORE: "memory" | "redis";
  readonly REDIS_URL: string;
  /** Prefix for every Redis key, so several apps (or test suites) can share one Redis. */
  readonly REDIS_PREFIX: string;
}

const MIN_SECRET_LENGTH = 32;

export class EnvError extends Error {
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string, problems: string[]): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  problems.push(`${name} must be a boolean (true/false), got "${raw}"`);
  return fallback;
}

/** Mirrors Express's accepted "trust proxy" values: boolean, hop count, or address/subnet list. */
function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  if (raw === undefined || raw.trim() === "") return "loopback";
  const v = raw.trim();
  if (v.toLowerCase() === "true") return true;
  if (v.toLowerCase() === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const problems: string[] = [];

  let port = 3000;
  if (source.PORT !== undefined && source.PORT !== "") {
    port = Number(source.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      problems.push(`PORT must be an integer between 0 and 65535, got "${source.PORT}"`);
    }
  }

  const secret = source.JWT_SECRET ?? "";
  if (secret === "") {
    problems.push("JWT_SECRET is required (see .env.example)");
  } else if (secret.length < MIN_SECRET_LENGTH) {
    // Never echo the secret itself, only its length.
    problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length})`);
  }

  const demoMode = parseBoolean(source.DEMO_MODE, false, "DEMO_MODE", problems);

  const nodeId = source.NODE_ID?.trim() || "single";
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(nodeId)) {
    problems.push(`NODE_ID must be 1–32 characters of letters, digits, ".", "_" or "-", got "${source.NODE_ID}"`);
  }

  const store = (source.LIMITER_STORE?.trim() || "memory").toLowerCase();
  if (store !== "memory" && store !== "redis") problems.push(`LIMITER_STORE must be "memory" or "redis", got "${source.LIMITER_STORE}"`);
  const redisUrl = source.REDIS_URL?.trim() || "redis://127.0.0.1:6379";
  if (!/^rediss?:\/\//.test(redisUrl)) problems.push(`REDIS_URL must start with redis:// or rediss://`);
  const redisPrefix = source.REDIS_PREFIX ?? "rlr:";
  if (!/^[A-Za-z0-9:_.-]{0,32}$/.test(redisPrefix)) problems.push(`REDIS_PREFIX must be up to 32 of [A-Za-z0-9:_.-]`);

  if (problems.length > 0) throw new EnvError(problems);

  return Object.freeze({
    PORT: port,
    JWT_SECRET: secret,
    TRUST_PROXY: parseTrustProxy(source.TRUST_PROXY),
    DEMO_MODE: demoMode,
    CORS_ORIGIN: source.CORS_ORIGIN?.trim() || "http://localhost:5173",
    NODE_ID: nodeId,
    LIMITER_STORE: store as "memory" | "redis",
    REDIS_URL: redisUrl,
    REDIS_PREFIX: redisPrefix,
  });
}
