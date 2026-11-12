# Improvements: making this a stronger portfolio project

## Read this first: what the application actually asks for

> "No need to make it overly formal or polished. We're mainly interested in seeing your actual work, understanding
> your technical contributions, and getting a feel for how you explain the projects you've handled."

They're judging **train of thought**, not size. For this application, the scope is already enough. The best
investment is in **understanding and explaining**, not more infrastructure. The tiers below are optional, and the
Redis/Docker work mostly serves as talking points ("here's what I'd do next and why").

### What to do instead (priority for this application)

1. **Be able to explain every part without notes.** For each item, be ready to answer "why this and not the alternative?":
   - Why auth runs before the limiter (forged tokens would drain a victim's budget).
   - Why login counts only *failures* per IP (round 4 vs. round 5 need opposite things).
   - Fixed vs. sliding vs. token, and which to pick for a public API (token bucket: bursty clients, O(1), no boundary).
   - Why `algorithms: ["HS256"]` is pinned, and what `alg: none` would allow.
   - Key by IP vs. user: account rotation vs. shared NAT, and why real systems combine both.
   - Why `trust proxy = loopback`, and why that's a demo-only setting.
   - Why `X-Client-Id` was removed.
   - The honest limits, and what you'd change (Redis + Lua, a reverse proxy in front).
   A good self-test: open a file at random and explain what it does and why it exists.

2. **Be clear about your contributions, including AI use.** "Your technical contributions" is an explicit ask. Say
   plainly what you designed and decided, what you reviewed or changed, and that you used an AI assistant for
   implementation. Examples of real decisions made during this project:
   - Choosing the scope and the five-round game format.
   - Splitting the work into tasks 00–10 and building them one branch and PR at a time.
   - Accepting or rejecting design calls (for example failure-only login limiting, and attackers in rounds 1–3 and 5
     being authenticated).
   - Questioning whether Redis/NGINX were needed, and deciding to keep them as documented next steps.
   Interviewers increasingly expect AI use. What they're testing is whether *you* own the reasoning.

3. **Write a short "my notes" file in your own words** (for example `NOTES.md`, informal, 1–2 pages). Cover: what
   problem this explores, 3–4 decisions and why, one thing that surprised you (for example the token bucket failing
   the original scoring formula, or the fixed-window edge burst letting 20 of 20 through), and what you'd do next.
   That's exactly the "how you explain" signal they're asking for, and it shouldn't be polished.

4. **Record the 2–5 minute walkthrough** (already planned in the design doc): round 2 for the algorithm trade-off,
   round 5 for the keying argument, `npm run smoke` to show the numbers are real.

5. **Optional and small:** I-01 (CI) is cheap and shows hygiene. Everything else below is "what I'd do next" talking
   material, not required work.

---

## Where the project stands

**Strengths.** This is a narrow project that goes deep: three limiters with measured trade-offs, JWT hardening
(pinned algorithm, `alg: none`, 401 reasons), middleware order with a test that proves it, keying trade-offs shown
in a playable round, and numbers checked against the server's own stats. 223 tests and an honest-limits section.
That's a strong interview conversation, and it shows judgment, not just features.

**What a reviewer might hold against it.**
1. **"It's a demo, not a system."** All state is in memory, it runs as one instance, there's no database, and it isn't
   deployed. The README *explains* how production would work but never *shows* it.
2. **Narrow surface.** One topic. A backend role usually also looks for persistence, deployment, CI, and observability.
3. **Nothing to click.** No live URL and no CI badge. Most reviewers spend 2 minutes on a repo.

The improvements below are ranked by **signal per hour**. Tier 1 alone changes the story from
"I can explain production" to "I built the production version and measured it".

Before choosing, compare against the job description. A platform/SRE role weights tiers 1 and 3. A product backend
role weights tiers 1 and 2.

---

## Tier 1: highest impact (do these first)

### I-01 CI pipeline (GitHub Actions) · size S
- Run `npm ci`, `npm run typecheck` and `npm test` on every push and PR. Then start the server and run `npm run smoke` against it.
- Add a status badge to the README.
- **What it shows:** professional hygiene. It's cheap, and reviewers notice when it's missing.
- **Done when:** PRs show a green check, and a broken test blocks merging (branch protection on `main`).

### I-02 Redis-backed limiters + multi-instance proof · size L · **the flagship upgrade**
- Add a `LimiterStore` behind the existing `RateLimiter` interface. Keep the in-memory store as the default and add
  `REDIS_URL` to switch.
  - Fixed window: `INCR` + `PEXPIRE` (atomic via `MULTI` or a Lua script).
  - Sliding log: sorted set (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE`) in **one Lua script**.
  - Token bucket: hash `{tokens, last}` with refill + take in **one Lua script**. Use Redis `TIME`, not the app
    clock, so instances with skewed clocks agree.
- Decide and document **fail-open vs. fail-closed** when Redis is unavailable. Make it configurable and test both.
- Keys get TTLs, which also fixes the "no stale-key sweeping" limit.
- **The experiment that makes it convincing:** run 2 app instances behind a load balancer and replay round 1.
  - In-memory: the attacker gets about 2× the limit, because each instance has its own counters.
  - Redis: exactly 1× the limit.
  - Put both measured numbers in the README.
- **What it shows:** distributed-systems thinking (atomicity, race conditions, clock skew, failure modes). This is the
  natural follow-up question for any rate-limiter project, and you'd have a measured answer.
- **Done when:** the Day 1 checks and the scenario tests pass against both stores, and the 2-instance experiment is in the README.

### I-03 Docker Compose: NGINX + 2 app instances + Redis · size M
- A `Dockerfile` (multi-stage, non-root user, `npm ci --omit=dev`) and `docker-compose.yml` with `nginx`, `api` ×2, `redis`.
- NGINX:
  - terminates the connection and sets `X-Forwarded-For` from the real client address,
  - load-balances across the two instances,
  - applies a coarse `limit_req` per IP at the edge.
- Set `TRUST_PROXY` to the NGINX container's address, not `loopback`. This removes the "simulated IP" caveat for
  the production profile, while the demo profile keeps it.
- **What it shows:** defense in depth (edge limiting for cheap floods, app limiting for identity-aware rules) and
  correct `trust proxy` setup.
- **Done when:** `docker compose up` runs the whole stack and the I-02 experiment runs against it.

### I-04 Deploy it with a live URL · size S–M
- Deploy the backend (and later the frontend) to Fly.io, Render or Railway, with managed Redis (for example Upstash).
- Put the URL at the top of the README. The video and the live demo then point at the same thing.
- Protect `/api/defense` first (see I-06), or run the public deploy in a mode where each visitor gets an isolated session.
- **What it shows:** you can ship, not just code.
- **Done when:** a stranger can open the URL and play round 5.

---

## Tier 2: broaden the backend surface

### I-05 Real users and persistence (Postgres or SQLite) · size M
- Replace the hard-coded user list with a `users` table, **argon2id/bcrypt** password hashes, and migrations (Drizzle or Prisma, or plain SQL).
- Optional: a `POST /api/register` endpoint with its own rate limit and validation. It makes the round 5 story real:
  account creation is the attacker's lever, and signup friction is the defense.
- **What it shows:** data modelling and password storage done right.

### I-06 Refresh tokens, rotation, and revocation · size M
- Short access token (5–15 min) plus a long refresh token stored server-side (hashed), **rotated on every use**, with
  **reuse detection**: if a refresh token is used twice, revoke the whole token family.
- `POST /api/logout` and a `jti` denylist in Redis with a TTL equal to the token's remaining life.
- An admin role claim, and make `/api/defense` and `/api/stats` admin-only (closes another honest limit).
- **What it shows:** you know the JWT revocation trade-off and implemented the standard answer, not just described it.

### I-07 OpenAPI spec + request validation · size S–M
- `openapi.yaml` describing every endpoint, served with Swagger UI at `/docs`.
- Validate bodies with a schema library (zod) and generate types from one source.
- **What it shows:** API design discipline. It also makes the frontend contract explicit.

### I-08 A 4th algorithm: sliding window counter · size S
- The approximate O(1) algorithm that weights the previous window's count by how much of it still overlaps (the
  approach Cloudflare describes). It has nearly the sliding log's accuracy at the fixed window's memory cost.
- Add it to the trade-off table with measured round 2 numbers and a memory comparison against the sliding log.
- **What it shows:** you know the algorithm production systems actually use and why.

---

## Tier 3: operability (strong for platform/SRE roles)

### I-09 Observability · size M
- Structured JSON logs (pino) with a request ID on every line and in the response headers.
- `GET /metrics` in Prometheus format: request counts by route/status, limiter allow/deny by algorithm and key type,
  limiter decision latency, tracked keys.
- Optional: a Grafana dashboard in the Compose stack that shows a round 5 attack live.
- **What it shows:** you think about running the service, not just writing it.

### I-10 Load testing and benchmarks · size S–M
- `autocannon` or `k6` scripts that measure:
  - throughput and p50/p99 latency with no limiter vs. each algorithm,
  - in-memory vs. Redis,
  - memory per 10k keys for the sliding log vs. the others.
- Put a measured results table in the README.
- **What it shows:** you back claims ("sliding log costs memory", "Redis adds ~1 ms") with numbers.

### I-11 Production hardening · size S
- Graceful shutdown (stop accepting, drain in-flight requests, close Redis), `/healthz` vs. `/readyz`, security
  headers (helmet), request timeouts, and `npm audit` in CI.

---

## Tier 4: polish and presentation

### I-12 Architecture write-up · size S
- One diagram (request flow and deployment), plus 3–4 short **ADRs (Architecture Decision Records)**: why auth runs before the limiter, why login counts
  failures only, why the token bucket is the recommended default, and the Redis fail-open/closed choice.
- **What it shows:** you can communicate decisions, which is most of a senior interview.

### I-13 Test coverage report · size S
- Run `node --test --experimental-test-coverage` in CI, and add a coverage badge.

---

## Suggested order (only if you want to go beyond this application)

1. **I-01 CI** (an hour or two, an immediate credibility boost).
2. **I-02 Redis + I-03 Compose** together. This is the big one, and the 2-instance experiment is the headline result.
3. **I-04 Deploy** with the frontend, so there's a link to share.
4. Then pick based on the job description: **I-06 + I-05** for product backend roles, **I-09 + I-10** for platform roles.

**Stop there and polish rather than adding everything.** A focused project with a deployed demo, CI, a distributed
store, and measured numbers is stronger than a sprawling one. The interview story then becomes: "I built it
in-memory, measured where that breaks with two instances, fixed it with Redis and atomic Lua scripts, and here are the
numbers."

---

## Q&A: running 3 Node servers (a distributed setup)

### 1. Do we need Docker for it?

**No.** Docker makes it a one-command setup for whoever clones the repo, but nothing about 3 servers requires it.
Without Docker:

- **3 app processes:** `PORT=3001 npm run dev`, `PORT=3002 …`, `PORT=3003 …` (or one script that starts all three).
- **A load balancer:** NGINX from Homebrew, or a ~30-line Node round-robin proxy on `:3000`. The proxy runs on
  loopback, so the existing `trust proxy = loopback` keeps the simulated client IPs working unchanged.
- **Redis** (only for the "fixed" version): `brew install redis && redis-server`.

Add Docker Compose later if you want reviewers to run it with `docker compose up`.

**The part people miss:** it isn't only the limiter counters that are per-process. *Everything* in memory is:
- `POST /api/defense` lands on **one** node, so the other two keep the old config.
- `/api/stats` only shows the node that answered.
- The login lockout lives on one node, so a stuffer gets 5 failures **per node** (15 in total).

A distributed version has to share the defense config, the limiter state, the login guard and the stats (Redis for
all of them). The quick alternative is a proxy that broadcasts `POST /api/defense` to all nodes.

### 2. Can I do it in 2 hours, and is it meaningful to explain?

**A scoped version, yes, and it's very meaningful. The full version, no** (that's more like a day or two).

**Fits in about 2 hours:**
1. **Show the problem (~45 min).** Start 3 nodes behind a round-robin proxy that broadcasts deploys. Replay round 1
   or 5 (keyed by IP). Expected: the attacker gets **about 3× the limit**, because each node has its own counter. Then
   measure it (`replay` already reports what got through). This is the core insight: *in-memory rate limiting
   silently breaks when you scale horizontally.*
2. **Fix it for one algorithm (~1 hour).** A Redis-backed **fixed window** (`INCR` + `PEXPIRE`, the simplest
   atomic one). Rerun: back to **1×**. Put both numbers in the README.
3. **Explain the rest instead of building it (~15 min).** Write up why sliding log and token bucket need a **Lua
   script** (read-modify-write must be atomic, or two nodes race), why to use Redis `TIME` (clock skew between nodes),
   and the **fail-open vs. fail-closed** choice when Redis is down.

**Known catch:** `RateLimiter.allow()` is synchronous today, and Redis is async. Changing the interface to return a
`Promise` touches the middleware, the login guard and many tests. In the 2-hour version, keep it contained: add an
async limiter only for `/api/resource` behind a `LIMITER_STORE=redis` flag, and leave the rest in memory (say so).

**Why it's worth it for this application:** it's pure train of thought. "I built it in-memory, predicted it would
break with 3 nodes, measured 3×, fixed one algorithm with Redis, measured 1×, and here's what the other two need."
That's a better story than a big feature list.

### 3. Do 3 servers let me add rounds like a concert-ticket spike?

The scenario idea is good, but note: **the spike rounds don't need 3 servers.** The algorithms work the same on one
node. What the concert case brings is a **different kind of problem**, and that's the interesting part to explain:

- **Rounds 1–5 are abuse:** a few clients sending too much. Per-client limits (per IP or user) fix it.
- **A ticket drop is legitimate demand:** 50,000 real fans, each sending a *reasonable* number of requests. Per-client
  limits block nobody, yet the server still falls over. What you need is a **global** capacity limit plus a fair way
  to choose who waits: a **virtual waiting room / queue**, concurrency limits, load shedding (503 + `Retry-After`),
  and priority for requests that are already mid-checkout.

**This is where the 3 servers connect:** a *global* limit ("500 checkouts/s in total") is exactly the thing that
breaks across nodes without shared state. Each node would allow 500, so 1,500 in total. So a "Ticket Drop" round is
a natural reason for the distributed work.

**"Different APIs are designed for different situations"** is a strong interview theme. Examples to talk through
(no code needed):

| API type | Typical limiting design | Why |
|---|---|---|
| Ticket drop / flash sale | Global limit + waiting room queue, per-user cap of 1 checkout | Demand is legitimate, capacity is the bottleneck, fairness matters |
| Login / password reset | Failures per IP **and** per account, strict sliding window | Brute force; a hard guarantee matters more than bursts |
| Public REST API (Stripe, GitHub) | Token bucket per API key, tiered by plan, `RateLimit-*` headers | Bursty but well-behaved clients; quotas are part of the product |
| Payments / writes | Low limits + **idempotency keys** | A retry must never charge twice |
| Search / reads | Generous token bucket, plus caching | Cheap, bursty, user-facing |
| GraphQL | **Cost-based** limiting (query complexity), not request count | One request can be 1 row or 1 million rows |
| Outbound (calling a third-party API) | Client-side limiter + exponential backoff with jitter | You're the one being rate-limited |

**Recommendation:** treat the table as talking material (or a section in your own `NOTES.md`). Build at most **one**
new round, "Ticket Drop", and only after the 2-hour distributed demo, because that demo is the bigger signal.
Doing both well is more than 2 hours.
