import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import type { Env } from "./config/env.js";
import { DefenseState } from "./config/defense.js";
import { getClientKeyIp } from "./middleware/clientIp.js";
import { LoginGuard } from "./auth/loginGuard.js";
import { defenseRouter } from "./routes/defense.js";
import { expiredTokenRouter, loginRouter } from "./routes/login.js";

export interface AppDeps {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Builds a fresh Express app. Every call gets its own in-memory state, so tests can create
 * isolated instances. Listening is done by server.ts, not here.
 */
export function createApp(env: Env, deps: AppDeps = {}): Express {
  const now = deps.now ?? Date.now;
  const defense = new DefenseState(now());
  const loginGuard = new LoginGuard();
  defense.onReset(() => loginGuard.reset());

  const app = express();
  // Exposed for tests and later middleware. Not reachable over HTTP.
  app.locals.defense = defense;
  app.locals.loginGuard = loginGuard;

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      allowedHeaders: ["Content-Type", "Authorization", "X-Forwarded-For"],
      exposedHeaders: ["Retry-After"],
    }),
  );

  app.use(express.json({ limit: "10kb" }));

  // Unlimited routes.
  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "healthy",
      service: "Rate Limit Royale API",
    });
  });
  app.use("/api/defense", defenseRouter(defense, now));

  // Login: its own IP-keyed failure limiter, independent of the configured defense.
  const loginDeps = { secret: env.JWT_SECRET, guard: loginGuard, now };
  app.use("/api/login", loginRouter(loginDeps));

  if (env.DEMO_MODE) {
    // Demo-only: a correctly signed but already-expired token (round 4's expired-token client).
    app.use("/api/demo/expired-token", expiredTokenRouter(loginDeps));
    // Demo-only: lets the frontend confirm which IP the server sees for a simulated client.
    app.get("/api/demo/whoami", (req, res) => {
      res.status(200).json({ ip: getClientKeyIp(req) });
    });
  }

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
