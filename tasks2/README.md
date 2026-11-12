# Tasks 2: Distributed mode (3 nodes, Redis on/off, load-balancing modes)

## Goal

Turn the README's "honest limit" (in-memory state only works on one instance) into a **measured experiment**:

> Single node on purpose. Predicted that 3 nodes would leak, measured ~3×. Fixed it with Redis and atomic Lua
> scripts, measured 1×. Tried sticky routing (hash by client IP): it hides the problem without fixing it.

The five rounds don't change. This adds **one new lesson (scaling)** that shows up in the numbers of every round.

## The experiment matrix (the deliverable)

Round 5 keyed by IP and round 4's login lockout, run through the load balancer:

| Load balancing | Redis off | Redis on |
|---|---|---|
| Round robin | ~3× leak (each node has its own counter) | 1× (shared counter) |
| Hash by client IP (sticky) | ~1×, *looks* fixed. Breaks when a node dies or the client changes IP. | 1× |

Plus one failure test: kill a node mid-round in sticky mode, and the attacker gets a fresh budget on the node it lands on next.

## Architecture

```
replay / frontend ──► NGINX :8080 ──┬──► node A :3001 ─┐
   (X-Forwarded-For                 ├──► node B :3002 ─┼──► Redis :6379 (when LIMITER_STORE=redis)
    = simulated IP)                 └──► node C :3003 ─┘
```

- NGINX runs on loopback and appends `127.0.0.1` to `X-Forwarded-For`. The nodes keep `trust proxy = loopback`, so
  simulated client IPs keep working with no app changes.
- `npm run dev` on `:3000` (single node, in memory) keeps working exactly as today. Distributed mode is opt-in.

## Task order

| # | Task | Depends on | Size |
|---|---|---|---|
| 00 | [Local infra: Redis, NGINX, cluster runner](00-local-infra.md) | none | S |
| 01 | [Measure the leak (Redis off)](01-measure-the-leak.md) | 00 | S |
| 02 | [Async limiter interface](02-async-limiter-interface.md) | none | M |
| 03 | [Shared defense state in Redis](03-shared-defense-state.md) | 02 | M |
| 04 | [Redis limiters (Lua)](04-redis-limiters.md) | 03 | M–L |
| 05 | [Redis login guard](05-redis-login-guard.md) | 04 | S |
| 06 | [Redis failure mode (fail open / closed)](06-failure-mode.md) | 04 | S |
| 07 | [Load-balancing modes + the experiment](07-lb-modes-and-experiment.md) | 01, 04, 05 | S–M |
| 08 | [README update](08-readme-update.md) | 07 | S |

**Honest estimate:** the full list is 1–2 days of focused work, not 2 hours.

**The 2-hour cut** (still a complete story):
1. 00 + 01: show the ~3× leak with Redis off. About 45 min.
2. A thin version of 02–04 for the **fixed window only**: an async path behind `LIMITER_STORE=redis`, one Lua script. About 1 hour.
3. Rerun and get 1×. Write up why sliding/token need their own Lua scripts and why login/stats also need shared state. About 15 min.

## What's automated vs. manual

**Nothing here needs manual configuration from you.** Everything is config files and scripts in the repo:
- `infra/nginx/*.conf`, run with `nginx -c <repo>/infra/...` on port 8080, so no `sudo`.
- Redis runs in the foreground from a script with no persistence (`redis-server --save "" --appendonly no`).
- `npm run cluster` starts and stops everything.

**What you might do by hand:**
- Approve `brew install redis nginx` (a one-time install; I can run it).
- *Optional:* start Docker Desktop if you prefer `docker compose up` (see 00). Docker isn't required.
- *Frontend:* when testing the game against the cluster, point the Vite proxy at `:8080` instead of `:3000`.

## Conventions (same as `tasks/`)

- Time stays injectable. Lua scripts take `now` as an argument, so tests can use a fake clock (see 04 for the trade-off vs. Redis `TIME`).
- Redis tests run when `REDIS_URL` is set and are skipped otherwise, so `npm test` still works with no Redis.
- One branch and PR per task.
