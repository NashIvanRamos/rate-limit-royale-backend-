# Frontend Steps: Rate Limit Royale (React + Vite)

This is a self-contained brief for building the frontend. Sources: the design doc (`src/project_overview.md`)
and the backend as actually implemented in this repo (tasks 00–06). **Where they differ, the backend contract
below wins**, because it describes what the server really does.

---

## 0. What we're building (one paragraph)

A single-page React game. Each of 5 rounds shows an incoming attack, the player configures a rate-limit
defense (algorithm, max requests, window, key by IP/user), deploys it to the real Express API, and the
browser fires a scripted mix of attacker and legitimate traffic at it. Every number on the results card
comes from real HTTP responses: 200 accepted, 429 blocked, 401 rejected auth. Round 5 (account rotation) is the climax:
the Key-by-IP / Key-by-user toggle flips the outcome.

Stack: React + Vite, plain `fetch`, no state library (a `useReducer` is enough), no UI kit needed.
Language: JSX (TypeScript optional, since the shapes below translate directly).

---

## 1. Backend contract (as implemented)

Base URL from the browser: `/api/...` via the Vite proxy (section 2). The backend runs on `http://localhost:3000`.

### Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | none | Never limited. `{ status: "healthy", service, uptimeS, algorithm, keyBy }` |
| GET | `/api/defense` | none | Current `{ config, deployedAt, windowEpochMs }` |
| POST | `/api/defense` | none | Deploy a defense. **Resets the limiter and the login lockouts.** |
| POST | `/api/login` | none | Demo login. IP-limited on **failed** attempts. |
| GET | `/api/resource` | Bearer JWT | The protected endpoint under attack. |
| POST | `/api/demo/expired-token` | none | Demo only: a correctly signed but already-expired token. |
| GET | `/api/demo/whoami` | none | Demo only: `{ ip }`, the IP the server sees for this request. |

Unknown routes → `404 { error: "not_found" }`. Malformed JSON → `400 { error: "bad_request" }`.

### `POST /api/defense`
```json
// request (all fields required, no extra fields, numbers must be integers, not strings)
{ "algorithm": "fixed" | "sliding" | "token", "maxRequests": 5..100, "windowMs": 1000..60000, "keyBy": "ip" | "user" }

// 200
{ "config": { ...same... }, "deployedAt": 1731234567890, "windowEpochMs": 1731234567890 }

// 400
{ "error": "invalid_config", "details": [{ "field": "maxRequests", "message": "must be between 5 and 100" }] }
```
Fixed-window boundaries are at `windowEpochMs + k × windowMs`. Round 2 uses this to aim its bursts.

### `POST /api/login` and `POST /api/demo/expired-token`
```json
// request
{ "username": "alice", "password": "pass-alice" }

// 200 /api/login
{ "token": "eyJ...", "tokenType": "Bearer", "sub": "alice", "expiresIn": 900 }
// 200 /api/demo/expired-token
{ "token": "eyJ...", "tokenType": "Bearer", "sub": "carol", "expired": true }

// 400 { "error": "bad_request" }            missing or non-string fields
// 401 { "error": "invalid_credentials" }    wrong user or password (identical either way)
// 429 { "error": "rate_limited", "retryAfterMs": 60000 }  + Retry-After header (seconds)
```
Login limiter: **5 failed attempts per IP per 60s**. Once exceeded, every login from that IP gets 429 (even
with correct credentials) until the window passes. Successful logins don't count, so 50 accounts can log in
from one IP (needed for round 5). The two endpoints share the same failure counter.

### `GET /api/resource`
Headers: `Authorization: Bearer <token>` and `X-Forwarded-For: <simulated client ip>` (section 2).
```json
// 200
{ "ok": true, "sub": "alice", "servedAt": 1731234567890 }
// 401 (auth runs first; the limiter is NOT touched)
{ "error": "unauthorized", "reason": "missing_token" | "invalid_signature" | "expired" | "malformed" }
// 429
{ "error": "rate_limited", "retryAfterMs": 4200 }
```
Response headers (readable cross-origin): `RateLimit-Limit`, `RateLimit-Remaining`, and `Retry-After` on 429.

What produces each 401 reason:
- `missing_token`: no `Authorization` header, or not `Bearer <token>`
- `invalid_signature`: wrong secret, tampered payload, `alg: none`, any algorithm other than HS256
- `expired`: correctly signed, `exp` in the past (the demo expired-token client)
- `malformed`: garbage like `abc` or `a.b.c`, or a payload without `sub`/`exp`

Key used by the limiter: `keyBy: "user"` → the token's `sub`. `keyBy: "ip"` → the client IP.

### Demo users
- Legitimate clients: `alice`, `bob`, `carol`
- Attacker account pool: `user01` … `user50`
- Password for everyone: `pass-<username>` (for example `pass-user07`)

Keep legitimate and attacker identities separate: never give an attacker a legit account.

---

## 2. Simulating many clients from one browser (important)

Every request leaves the same browser, so without help the server would see one IP for everybody and
"Key by IP" would be meaningless. The backend trusts `X-Forwarded-For` **only from loopback**
(`trust proxy = loopback`), so the frontend can set a per-client simulated IP:

```js
fetch("/api/resource", { headers: { Authorization: `Bearer ${t}`, "X-Forwarded-For": client.ip } })
```

`vite.config.js`:
```js
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", xfwd: true },
    },
  },
});
```
`xfwd: true` makes the proxy append `127.0.0.1` like a real proxy hop. Express skips the trusted hop and
picks the simulated IP.

**First thing to verify (step 1):** `fetch("/api/demo/whoami", { headers: { "X-Forwarded-For": "10.0.0.7" } })`
must return `{ ip: "10.0.0.7" }`. If it doesn't, nothing in rounds 1–5 will key correctly.

IP plan (stable across rounds):
- Legit: `alice 10.0.0.1`, `bob 10.0.0.2`, `carol 10.0.0.3`
- Attackers: `10.6.6.6` (main attacker), `10.6.6.7`–`10.6.6.9` for round 4's token forgers if you want
  them separate.

---

## 3. Round lifecycle (order matters)

```
briefing ──Continue──▶ configuring ──Deploy──▶ firing ──script done──▶ results ──Next──▶ briefing
                                                                          (round 5 → summary)
```
Inside **firing**, always in this order:
1. **Deploy:** `POST /api/defense` with the player's config. This resets the limiter and login lockouts.
   Keep `deployedAt` and `windowEpochMs`.
2. **Setup:** log in every client that needs a token (legit clients and round 5's 50 pool accounts) and
   fetch the expired token for round 4. Each login is sent with that client's `X-Forwarded-For`.
   Setup requests are **not** tallied.
3. **Fire:** schedule the scenario's events relative to a start time and tally every response.
4. **Drain:** wait for all in-flight requests (`Promise.allSettled`), then compute results and switch to `results`.

Deploy must come before setup. Otherwise a lockout from the previous round would block this round's logins.

---

## 4. Scenario design

### Shape
Scenarios are **functions of the deployed config**, not static arrays, because round 2 must aim at the real
window boundary and attackers "know" the limit (a real attacker reads `RateLimit-Limit`).

```js
// scenarios.js
export const SCENARIOS = [
  {
    id: 1,
    name: "Steady Flood",
    description: "One client hammers /api/resource at a constant high rate.",
    clients: [
      { id: "alice", ip: "10.0.0.1", legit: true,  auth: { type: "login", username: "alice" } },
      { id: "bob",   ip: "10.0.0.2", legit: true,  auth: { type: "login", username: "bob" } },
      { id: "atk",   ip: "10.6.6.6", legit: false, auth: { type: "login", username: "user01" } },
    ],
    // ctx = { config, windowEpochMs, startAt }  (startAt = Date.now() when firing begins)
    build: (ctx) => [ /* { at, clientId, path, body? } … */ ],
    durationMs: 10_000,   // for the briefing tile; build() may extend it (round 2)
  },
  // …
];
```
Event: `{ at: msFromStart, clientId, path: "/api/resource" | "/api/login", body? }`.
`client.auth.type` ∈ `"none" | "login" | "forged" | "algNone" | "expired" | "garbage"`.
Briefing stat tiles come from the built events: requests = `events.length`, client IPs = distinct `ip`, duration.

### Legitimate traffic (every round)
2–3 legit clients each send about **1 request every 1.5s** for the whole round. That's light, but enough that an
over-tight defense (for example 5 per 60s) produces legitimate blocks, which is the tension the player must balance.

### Rounds

| # | Name | Attacker behaviour (suggested numbers) | Lesson |
|---|---|---|---|
| 1 | Steady Flood | `user01` from `10.6.6.6`, 1 request every 50ms for 10s (~200 req). | Any algorithm contains it. |
| 2 | Edge Exploit | `user01` from `10.6.6.6`. Burst of `maxRequests` at `boundary − 400ms`, another at `boundary + 100ms`, where `boundary = windowEpochMs + windowMs`. Duration ≈ `windowMs + 2s`. | Fixed window lets ~2× through. Sliding and token don't. |
| 3 | Burst Attack | `user01` from `10.6.6.6`, 100 requests evenly over 5s. | Token bucket: initial burst, then the refill rate. Sliding: strict per window. |
| 4 | Credential Stuffing + Forged Tokens | (a) `10.6.6.6` POSTs `/api/login` ~60× in 6s with wrong passwords for pool users. (b) `10.6.6.7` sends forged-signature tokens and (c) `10.6.6.8` sends `alg: none` tokens to `/api/resource`, ~5/s each. (d) Legit `carol` uses the **expired** token. | Login has its own limit (5 × 401, then 429s). Forged tokens → 401 and never touch the limiter. Carol → 401 `expired`, not a legit block. |
| 5 | Account-Rotation Boss Wave | All 50 pool accounts log in (setup) from `10.6.6.6`, then each sends ~6 requests spread over 10s (~300 req). Legit alice/bob/carol as usual. | Key by user: each account gets its own budget, so the attacker gets ~50× through. Key by IP: one budget, so it's contained. |

**Decision: attackers in rounds 1–3 and 5 are authenticated (they log in with pool accounts).** The design
doc says round 1's attacker is unauthenticated, but `/api/resource` runs auth **before** the limiter, so an
unauthenticated flood is 100% 401s whatever the config, and the limiter would never be exercised. Unauthenticated
and forged traffic is round 4's job.

Round 2 notes:
- Compute the boundary from wall-clock time (`startAt = Date.now()` when firing begins, which is the same machine as the
  server), and take the first boundary at least ~500ms after `startAt`, since setup logins may already have
  used up a short window:
  ```js
  const k = Math.ceil((startAt + 500 - windowEpochMs) / windowMs);
  const boundary = windowEpochMs + k * windowMs;          // server-time ms
  const before = boundary - 400 - startAt, after = boundary + 100 - startAt;  // event `at` offsets
  ```
- If the player picks a 60s window, the round waits ~60s for the boundary. Show a countdown ("Waiting for
  window boundary… 12s") and/or a hint in the briefing ("tip: try a short window").
- Browsers allow ~6 concurrent HTTP/1.1 connections per host, so a burst queues briefly. Use the response's
  `servedAt` (server time) if you want to show which window each request actually landed in.

### Building attack tokens in the browser (round 4)
```js
const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const nowS = () => Math.floor(Date.now() / 1000);
const claims = (sub) => ({ sub, iat: nowS(), exp: nowS() + 900 });

export const forgedToken = (sub) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims(sub))}.${b64url({ fake: crypto.randomUUID() })}`;
export const algNoneToken = (sub) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims(sub))}.`;
```
The expired token comes from `POST /api/demo/expired-token` (the browser can't sign without the secret).

---

## 5. Scheduler (`scheduler.js`)

Responsibilities: timed firing, latency, tally.

```js
export async function runScenario({ events, clients, tokens, onProgress, signal }) {
  const startAt = performance.now();
  const records = [];
  const inflight = events.map((ev) => new Promise((resolve) => {
    const timer = setTimeout(async () => {
      const client = clients[ev.clientId];
      const t0 = performance.now();
      let status = 0, body = null;
      try {
        const res = await fetch(ev.path, {
          method: ev.path === "/api/login" ? "POST" : "GET",
          headers: {
            "X-Forwarded-For": client.ip,
            ...(ev.body ? { "Content-Type": "application/json" } : {}),
            ...(tokens[client.id] ? { Authorization: `Bearer ${tokens[client.id]}` } : {}),
          },
          body: ev.body ? JSON.stringify(ev.body) : undefined,
          signal,
        });
        status = res.status;
        body = await res.json().catch(() => null);
      } catch { status = 0; /* network error / aborted */ }
      records.push({ ...ev, legit: client.legit, status, reason: body?.reason ?? body?.error, latencyMs: performance.now() - t0 });
      onProgress?.(records.length, events.length);
      resolve();
    }, ev.at);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); });
  }));
  await Promise.allSettled(inflight);
  return records;
}
```
Notes:
- Fire-and-forget: never `await` one request before scheduling the next.
- Keep the tab in the foreground while firing (background tabs throttle `setTimeout`).
- `status 0` (network error) is tallied separately as `errors`, never as accepted or blocked.
- An `AbortController` lets you cancel a round (route change, "Abort" button).

### Tally → results
```
accepted      = count(status 200)
blocked       = count(status 429)
rejectedAuth  = count(status 401)
avgLatencyMs  = mean(latencyMs)
legitBlocks   = count(legit && status 429)       ← the only thing that costs XP
legitExpired  = count(legit && status 401)       ← reported separately, costs nothing
attackTotal   = count(!legit)
attackStopped = count(!legit && (status 429 || status 401))
attackPassed  = count(!legit && status 200)
```
**401s never count as legitimate blocks.** That's a definition-of-done item.

---

## 6. Scoring (`scoring.js`, tunable)

Design doc rules: blocked or rejected attacker requests earn XP, legit blocks cost XP, legit 401 (expired)
costs nothing, full 500 XP needs zero legit blocks and attack traffic held near the configured limit.

Suggested formula (tune once real numbers exist):
```js
const windowsCovered = Math.floor(attackDurationMs / config.windowMs) + 1;
// What a perfect per-IP defense would let through (an attacker deserves the configured quota, no more).
const allowance = config.maxRequests * windowsCovered * attackerIpCount;
const containment = attackPassed <= allowance * 1.15 ? 1 : (allowance * 1.15) / Math.max(1, attackPassed);
const legitPenalty = Math.min(1, legitBlocks * 0.1);          // −10% per legit block
const xpEarned = Math.round(500 * containment * (1 - legitPenalty));
const cleared = legitBlocks === 0 && containment >= 0.8;
```
Sanity checks you should see:
- Round 2, fixed window → `attackPassed ≈ 2 × allowance` → containment ≈ 0.57, not cleared. Sliding window → cleared.
- Round 5, key by user → `attackPassed ≫ allowance` → near 0 XP. Key by IP → cleared.
- Any round with `maxRequests: 5, windowMs: 60000` → legit blocks → heavy penalty.

---

## 7. App state (`App.jsx`, `useReducer`)

```js
const initial = {
  round: 1, score: 0, phase: "briefing",
  config: { algorithm: "fixed", maxRequests: 10, windowMs: 10_000, keyBy: "ip" },
  firing: { stage: null, done: 0, total: 0 },  // stage: "deploying" | "logging-in" | "firing" | "draining"
  results: null, history: [],                   // history[] feeds the final summary
  serverOnline: false, error: null,
};
// actions: CONTINUE, SET_CONFIG, DEPLOY_START, FIRING_PROGRESS, ROUND_COMPLETE, NEXT_ROUND, SERVER_STATUS, ERROR
```
Config persists between rounds (the player tweaks it rather than starting over).

---

## 8. Components and layout

Single column, max-width ~640px, centered, dark background. Full-width stack on mobile.

| Component | Contents |
|---|---|
| `Header` | Title, subtitle "API Defense Arena", **Server Online** pill (poll `/api/health` every 5s; red "Offline" on failure), round counter `03 / 05`, progress bar, **Total XP** right-aligned in gold |
| `BriefingCard` | Red "Incoming Attack" tag, wave number, name, one-line description, 3 stat tiles: requests, client IPs, duration |
| `ConfigPanel` | `AlgorithmCards` (3 selectable cards with a one-line trade-off each), `KeyByToggle` (Key by IP / Key by user), sliders: max requests 5–100, window 1s–60s (store ms), live labels |
| `DefensePreview` | Algorithm, max requests, window, keying mode, with a blue "Preview" accent |
| `DeployButton` | Full-width green "Deploy Defense & Launch Attack". Disabled with a stage label and progress while firing |
| `ResultsCard` | Accepted (200), Blocked (429), Rejected auth (401), avg latency, legit blocks (+ "expired-token legit: N" note), stacked distribution bar, outcome banner (Cleared / Breached) with XP |
| `FinalSummary` | Per-round table from `history`, total XP (first on the cut list, after the lives system) |

### Visual tokens
```css
--bg: #0b0f17; --card: #141b26; --border: #263041;
--accepted: #4ade80; --blocked: #f87171; --auth: #fbbf24; --xp: #facc15; --preview: #60a5fa;
--radius: 14px; font-size: 14px; labels: 11px uppercase; numbers: monospace;
```
Colour signals status only: green accepted, red blocked, amber auth-rejected, gold XP. Never use it as decoration.

---

## 9. Project structure

```
client/
├── index.html
├── vite.config.js          # /api proxy with xfwd
└── src/
    ├── main.jsx
    ├── App.jsx             # reducer + phase switch
    ├── api.js              # deploy(), login(), expiredToken(), health(), resource()
    ├── tokens.js           # forgedToken(), algNoneToken()
    ├── scenarios.js        # five round definitions (build(ctx) → events)
    ├── scheduler.js        # runScenario()
    ├── scoring.js          # tally() + score()
    ├── styles.css          # tokens + layout
    └── components/
        ├── Header.jsx  BriefingCard.jsx  ConfigPanel.jsx  DefensePreview.jsx
        └── DeployButton.jsx  ResultsCard.jsx  FinalSummary.jsx
```

---

## 10. Steps (do in order, each with a "done when")

### Step 1: Scaffold and prove the plumbing
- `npm create vite@latest client -- --template react`, add the proxy from section 2.
- `api.js` with thin wrappers. A throwaway debug page calls `/api/health`, `/api/demo/whoami` with an
  `X-Forwarded-For`, logs in `alice`, hits `/api/resource`.
- **Done when:** whoami echoes the simulated IP and alice gets a 200 from `/api/resource` through the proxy.

### Step 2: Scheduler and tally (no UI)
- `scheduler.js` and `scoring.js` (tally only). Hard-code round 1 and run it from a button. Print the tally.
- **Done when:** with `maxRequests: 10, windowMs: 10000, keyBy: "ip"`, round 1 shows ~10–20 attacker 200s,
  the rest 429, and 0 legit blocks.

### Step 3: All five scenarios
- Write `scenarios.js` per section 4, including setup logins, round 4 tokens, round 2 boundary timing.
- **Done when:** each round runs end to end, and:
  - round 2 fixed lets ≈2× quota through, while sliding doesn't
  - round 4 shows login 401s, then 429s, plus forged and `alg: none` → `invalid_signature` and carol → `expired`
  - round 5 differs hugely between key by user and key by IP

### Step 4: Phase state machine (unstyled)
- `App.jsx` reducer: briefing → configuring → firing (stages) → results → next round, round 5 → summary.
- Wire config controls, deploy button, results card to real numbers. Add scoring and XP.
- **Done when:** rounds 1→5 play through with real numbers and XP accumulates (design doc Day 2 "done").

### Step 5: Styling to match the sample
- Tokens, cards, algorithm selector, sliders, preview panel, results card, distribution bar.
- Header with server pill, round counter, progress, XP.
- **Done when:** the full loop looks like the screenshot (design doc Day 3 "done").

### Step 6: Toggle, 401 row, states
- Key by IP / Key by user toggle, shown in the preview.
- Results: separate 401 row, plus the "expired-token legit (not penalised)" note.
- Loading and disabled states during firing, error banner if the server is offline or deploy returns 400.
- **Done when:** nothing is clickable mid-round, and an offline server is obvious.

### Step 7: Boss wave and polish
- Make sure round 5 is the visual climax (for example animate the attacker's 200 count, and show "50 keys vs 1 key").
- Result animations (count-up numbers, bar grow) and the final summary screen.
- **Done when:** recording round 2 then round 5 tells the algorithm story and the keying story in under 5 minutes.

### Step 8 (optional, after backend task 07): server cross-check
- Backend task 07 adds `GET /api/stats` (server-side 200/429/401 counts per round). Show
  "server confirms: 182 / 18 / 0" next to the client tally to prove the numbers are real.

---

## 11. Definition of done (frontend share)
- Five rounds run end to end with real request results.
- The keying toggle changes the outcome of round 5.
- 401s are reported separately from 429s and never count as legitimate blocks.
- Every number shown (and in the video) came from a real run, not example data.

## 12. Cut list (if time runs out, in order)
Lives system (not planned) → final summary screen → edge-exploit round. **Never cut auth (round 4) or round 5.**
