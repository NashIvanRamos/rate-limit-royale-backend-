# 00: Project setup and hygiene

## Goal
Make the existing scaffold a reliable base: env loads correctly, secrets are validated at boot,
JWT and test tooling are installed, and the temp route is replaced.

## Current state (observed)
- `src/.env` and `src/.gitignore` live **inside `src/`**. `import "dotenv/config"` loads `.env`
  from `process.cwd()` (the repo root when using npm scripts), so `src/.env` is **never loaded**.
  PORT only works because of the `|| 3000` fallback.
- `src/.gitignore` only applies under `src/`, so root `node_modules/` and `dist/` aren't ignored.
- `jsonwebtoken` isn't installed.
- `app.ts` has a temporary `GET /api/protected`. The doc calls it `/api/resource`.
- `"test"` script is a placeholder. `"main": "index.js"` is stale.

## Steps
1. Move `src/.env` → `.env` and `src/.gitignore` → `.gitignore` (root). Keep `node_modules`, `dist`, `.env`.
2. Add `.env.example` with:
   ```
   PORT=3000
   JWT_SECRET=change-me-to-32+-random-chars
   TRUST_PROXY=loopback
   DEMO_MODE=true
   CORS_ORIGIN=http://localhost:5173
   ```
3. `npm i jsonwebtoken` and `npm i -D @types/jsonwebtoken`.
4. Create `src/config/env.ts`: parse and validate env once.
   - `JWT_SECRET` required, length ≥ 32, otherwise **throw at boot** with a clear message.
   - `PORT` number, default 3000. `DEMO_MODE` boolean, default false. `TRUST_PROXY` default `loopback`.
   - Export a frozen typed `env` object. Nothing else reads `process.env`.
5. Split app building from listening: `app.ts` exports `createApp()` so tests get a fresh app
   and fresh in-memory state each time. `server.ts` loads dotenv, validates env, and calls `createApp().listen`.
6. Remove `/api/protected` (replaced in task 06).
7. CORS: origin from env, `allowedHeaders: ["Content-Type", "Authorization", "X-Forwarded-For"]`,
   `exposedHeaders: ["Retry-After"]` (the browser can't read Retry-After otherwise).
8. Scripts:
   ```json
   "test": "node --import tsx --test \"test/**/*.test.ts\"",
   "smoke": "tsx scripts/smoke.ts",
   "typecheck": "tsc --noEmit"
   ```
   Fix `"main"` to `dist/server.js`.
9. Add `src/types/express.d.ts` augmenting `Request` with `auth?: { sub: string; exp: number }`.

## Acceptance criteria
- `npm run dev` boots and logs the port read from the root `.env`.
- Boot fails fast with a readable error when `JWT_SECRET` is missing or short.
- `npm run typecheck` passes. `npm test` runs (even with zero tests).
- `GET /api/health` still returns 200.
