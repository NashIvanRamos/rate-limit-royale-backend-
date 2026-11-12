import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import type { Env } from "./config/env.js";
import { DEFAULT_DEFENSE, DefenseState } from "./config/defense.js";
import type { LimiterStoreFactory } from "./algorithms/index.js";
import { getClientKeyIp } from "./middleware/clientIp.js";
import { LoginGuard, RedisLoginGuard, type LoginGuardBackend } from "./auth/loginGuard.js";
import { defenseRouter } from "./routes/defense.js";
import { expiredTokenRouter, loginRouter } from "./routes/login.js";
import { resourceRouter } from "./routes/resource.js";
import { statsRouter } from "./routes/stats.js";
import { StatsCollector, type StatsBackend } from "./middleware/stats.js";
import { createRedis } from "./redis/client.js";
import { loadRound, MemoryRoundState, type RoundState } from "./state/round.js";
import { RedisRoundState } from "./state/redisRound.js";
import { RedisStats } from "./state/redisStats.js";
import { RedisLimiterStore } from "./algorithms/redisStore.js";

export interface AppDeps {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Where limiter state lives. Defaults to in-memory (tasks2/02). */
  limiterStoreFactory?: LimiterStoreFactory;
}

/**
 * Builds a fresh Express app. Every call gets its own in-memory state, so tests can create
 * isolated instances. Listening is done by server.ts, not here.
 */
export function createApp(env: Env, deps: AppDeps = {}): Express {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const app = express();

  let roundState: RoundState;
  let statsBackend: StatsBackend;
  let loginGuard: LoginGuardBackend;
  if (env.LIMITER_STORE === "redis") {
    // Shared across nodes: config, generation, limiter counters (atomic Lua scripts) and stats, all in Redis.
    const redis = createRedis(env.REDIS_URL);
    const injected = deps.limiterStoreFactory;
    roundState = new RedisRoundState(redis, env.REDIS_PREFIX, now, (algorithm, options, generation) =>
      injected ? injected(algorithm, options) : new RedisLimiterStore(redis, env.REDIS_PREFIX, algorithm, options, generation),
    );
    statsBackend = new RedisStats(redis, env.REDIS_PREFIX);
    loginGuard = new RedisLoginGuard(redis, env.REDIS_PREFIX);
    app.locals.redis = redis;
  } else {
    const memoryGuard = new LoginGuard();
    const defense = new DefenseState(now(), DEFAULT_DEFENSE, deps.limiterStoreFactory);
    const stats = new StatsCollector(now());
    defense.onReset(() => memoryGuard.reset());
    defense.onReset(() => stats.reset(now()));
    roundState = new MemoryRoundState(defense);
    statsBackend = stats;
    app.locals.defense = defense;
    app.locals.stats = stats;
    app.locals.loginGuard = memoryGuard;
    loginGuard = memoryGuard;
  }
  // Exposed for tests. Not reachable over HTTP.
  app.locals.roundState = roundState;
  app.locals.statsBackend = statsBackend;

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      allowedHeaders: ["Content-Type", "Authorization", "X-Forwarded-For"],
      // Without this the browser can't read these headers on cross-origin responses.
      exposedHeaders: ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "X-Node-Id"],
    }),
  );

  // Which node answered. Lets the replay show how a load balancer spread the traffic (tasks2).
  app.use((_req, res, next) => {
    res.setHeader("X-Node-Id", env.NODE_ID);
    next();
  });

  // Load the round once per request (limiter, login guard and stats all use this snapshot), then count.
  // Both before express.json(), so a login with malformed JSON (400 from the body parser) is still counted.
  app.use(loadRound(roundState));
  app.use(statsBackend.middleware());

  app.use(express.json({ limit: "10kb" }));

  // 1. Unlimited routes.
  app.get("/api/health", async (_req, res) => {
    const { config } = await roundState.current();
    res.status(200).json({
      status: "healthy",
      service: "Rate Limit Royale API",
      nodeId: env.NODE_ID,
      uptimeS: Math.floor((now() - startedAt) / 1000),
      store: roundState.backend,
      algorithm: config.algorithm,
      keyBy: config.keyBy,
    });
  });
  app.use("/api/defense", defenseRouter(roundState, now));
  app.use("/api/stats", statsRouter(statsBackend, roundState, env.NODE_ID));

  // 2. Login: its own IP-keyed failure limiter, independent of the configured defense.
  const loginDeps = { secret: env.JWT_SECRET, guard: loginGuard, now };
  app.use("/api/login", loginRouter(loginDeps));

  // 3. Demo helpers.
  if (env.DEMO_MODE) {
    // Demo-only: a correctly signed but already-expired token (round 4's expired-token client).
    app.use("/api/demo/expired-token", expiredTokenRouter(loginDeps));
    // Demo-only: lets the frontend confirm which IP the server sees for a simulated client.
    app.get("/api/demo/whoami", (req, res) => {
      res.status(200).json({ ip: getClientKeyIp(req) });
    });
  }

  // 4. Protected resource: authenticate → key selection → limiter → handler.
  app.use("/api/resource", resourceRouter({ secret: env.JWT_SECRET, now }));

  // 5. Fallbacks: JSON 404 and error handler (no stack traces in responses).
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // Body-parser errors carry a 4xx status (malformed JSON → 400, too large → 413).
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
  };
  app.use(errorHandler);

  return app;
}
