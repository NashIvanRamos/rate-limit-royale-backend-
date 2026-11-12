/**
 * The active defense: the player's chosen algorithm, limits and keying mode, plus the limiter instance
 * built from them. All in memory. Each `createApp()` owns its own DefenseState so tests stay isolated.
 */
import { ALGORITHMS, type Algorithm, type LimiterStore, type LimiterStoreFactory } from "../algorithms/index.js";
import { memoryStoreFactory } from "../algorithms/memoryStore.js";

export type KeyBy = "ip" | "user";
export const KEY_BY: readonly KeyBy[] = ["ip", "user"];

export interface DefenseConfig {
  algorithm: Algorithm;
  maxRequests: number;
  windowMs: number;
  keyBy: KeyBy;
}

/** Ranges match the frontend sliders (design doc §2). */
export const LIMITS = Object.freeze({
  maxRequests: { min: 5, max: 100 },
  windowMs: { min: 1_000, max: 60_000 },
});

export const DEFAULT_DEFENSE: Readonly<DefenseConfig> = Object.freeze({
  algorithm: "fixed",
  maxRequests: 10,
  windowMs: 10_000,
  keyBy: "ip",
});

export interface DefenseSnapshot {
  config: DefenseConfig;
  deployedAt: number;
  /** Fixed-window boundaries are at windowEpochMs + k * windowMs. */
  windowEpochMs: number;
}

type ResetListener = () => void;

export class DefenseState {
  private _config: DefenseConfig;
  private _store: LimiterStore;
  private _deployedAt: number;
  private readonly resetListeners: ResetListener[] = [];

  /** `storeFactory` picks where limiter state lives: in memory (default) or, later, Redis (tasks2/04). */
  constructor(
    now: number,
    config: DefenseConfig = DEFAULT_DEFENSE,
    private readonly storeFactory: LimiterStoreFactory = memoryStoreFactory,
  ) {
    this._config = { ...config };
    this._deployedAt = now;
    this._store = this.build(this._config, now);
  }

  get config(): Readonly<DefenseConfig> {
    return this._config;
  }

  /** Read at request time, never cached, so a redeploy mid-round takes effect immediately. */
  get store(): LimiterStore {
    return this._store;
  }

  get deployedAt(): number {
    return this._deployedAt;
  }

  /** Other per-round state (login limiter, stats) registers here to be cleared on every deploy. */
  onReset(listener: ResetListener): void {
    this.resetListeners.push(listener);
  }

  /** Replaces the config, builds a fresh store (all keys cleared), and resets dependent state. */
  deploy(config: DefenseConfig, now: number): DefenseSnapshot {
    this._config = { ...config };
    this._deployedAt = now;
    this._store = this.build(this._config, now);
    for (const listener of this.resetListeners) listener();
    return this.snapshot();
  }

  snapshot(): DefenseSnapshot {
    return { config: { ...this._config }, deployedAt: this._deployedAt, windowEpochMs: this._deployedAt };
  }

  private build(config: DefenseConfig, now: number): LimiterStore {
    return this.storeFactory(config.algorithm, {
      maxRequests: config.maxRequests,
      windowMs: config.windowMs,
      epochMs: now,
    });
  }
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type ValidationResult = { ok: true; config: DefenseConfig } | { ok: false; issues: ValidationIssue[] };

const FIELDS = ["algorithm", "maxRequests", "windowMs", "keyBy"] as const;

function checkInt(value: unknown, field: string, { min, max }: { min: number; max: number }, issues: ValidationIssue[]) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ field, message: `must be an integer` });
  } else if (value < min || value > max) {
    issues.push({ field, message: `must be between ${min} and ${max}` });
  }
}

function checkEnum(value: unknown, field: string, allowed: readonly string[], issues: ValidationIssue[]) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push({ field, message: `must be one of: ${allowed.join(", ")}` });
  }
}

/** Strict validation: every field required, no coercion ("10" is rejected), unknown fields rejected. */
export function validateDefenseConfig(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, issues: [{ field: "body", message: "must be a JSON object" }] };
  }
  const input = body as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(input)) {
    if (!(FIELDS as readonly string[]).includes(key)) issues.push({ field: key, message: "unknown field" });
  }
  for (const field of FIELDS) {
    if (!(field in input)) issues.push({ field, message: "is required" });
  }

  if ("algorithm" in input) checkEnum(input.algorithm, "algorithm", ALGORITHMS, issues);
  if ("keyBy" in input) checkEnum(input.keyBy, "keyBy", KEY_BY, issues);
  if ("maxRequests" in input) checkInt(input.maxRequests, "maxRequests", LIMITS.maxRequests, issues);
  if ("windowMs" in input) checkInt(input.windowMs, "windowMs", LIMITS.windowMs, issues);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: {
      algorithm: input.algorithm as Algorithm,
      maxRequests: input.maxRequests as number,
      windowMs: input.windowMs as number,
      keyBy: input.keyBy as KeyBy,
    },
  };
}
