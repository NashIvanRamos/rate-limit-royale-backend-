# Design Doc: Rate Limit Royale

**One-liner:** Pick a rate-limiting algorithm, choose how to identify clients, and tune your defense. Then fire real HTTP traffic at a live Express API with JWT auth to beat an attack without blocking legitimate users.

**Why it fits a backend interview:** Every mechanic maps to a real design decision: algorithm trade-offs, keying strategy, auth ordering, and the cost of getting any of them wrong. The numbers come from the server, so they can be verified live.

**Stack:** React + Vite (frontend), Node.js + Express (backend), `jsonwebtoken` for JWT, no database. All state is in memory.

---

## 1. Scope

**In scope**
- Single-page React app with three game phases: briefing, configuring, firing, results.
- Express API with login, JWT verification, a protected resource, and a health check.
- Three rate limiters behind one interface: Fixed Window, Sliding Window Log, Token Bucket.
- Keying toggle: by IP or by authenticated user.
- Five scripted rounds, including an auth-focused attack and an account-rotation boss wave.

**Out of scope**
- Refresh tokens, token revocation, and a real user database.
- Persistence, deployment, HTTPS, and multi-instance limiter state.
- Auth beyond the demo login, such as password hashing services or OAuth.

---

## 2. Layout

Single column, max width about 640px, centered on a dark background. On mobile it becomes a full-width stack.

From top to bottom:

1. **Header:** game title, subtitle "API Defense Arena," a "Server Online" pill (polled from `/api/health`), round counter (`03 / 05`), and a progress bar.
2. **Total XP** on the right, in gold.
3. **Attack briefing card:** red "Incoming Attack" tag, wave number, attack name, one-line description, and three stat tiles (requests, client IPs, duration).
4. **Configure your defense:**
   - Algorithm cards: Fixed Window, Sliding Window, Token Bucket (selected state).
   - Identity toggle: Key by IP / Key by user.
   - Sliders: max requests (5 to 100), time window (1s to 60s), with live labels.
5. **Defense preview panel:** algorithm, max requests, window, and keying mode.
6. **Deploy Defense & Launch Attack** button, full width, green.
7. **Results card** (after firing): accepted (200), blocked (429), rejected auth (401), average latency, legitimate blocks, response distribution bar, round outcome banner with XP.

---

## 3. Visual Tokens

- Background `#0b0f17`, card `#141b26`, border `#263041`.
- Accepted green `#4ade80`, blocked red `#f87171`, auth-rejected amber `#fbbf24`, XP gold `#facc15`, accent blue for "Preview."
- Corner radius 12 to 16px, body text 14px, uppercase labels 11px, monospace for numbers.
- Color signals status only. Don't use it decoratively.

---

## 4. Game State

```
round: 1..5
score: number (XP)
phase: "briefing" | "configuring" | "firing" | "results"
config: {
  algorithm: "fixed" | "sliding" | "token",
  maxRequests: number,
  windowMs: number,
  keyBy: "ip" | "user"
}
scenario: { id, name, description, clientCount, durationMs, script }
results: {
  accepted, blocked, rejectedAuth,
  avgLatencyMs, legitBlocks, xpEarned, cleared
}
```

Transitions: `briefing → configuring` (Continue) → `firing` (Deploy) → `results` (script ends) → `briefing` (next round). Round 5 ends in a final summary screen instead.

---

## 5. Backend

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/defense` | none | Set algorithm, limits, and keying mode. Resets limiter state. |
| POST | `/api/login` | none, IP-limited | Demo login. Returns a signed JWT. |
| GET | `/api/resource` | Bearer JWT | Protected endpoint. Limited by the configured limiter. |
| GET | `/api/health` | none | Status pill. Not limited. |

### Auth

- `POST /api/login` checks credentials against a small in-memory user list (for example, 50 demo accounts such as `user01` to `user50`).
- Returns an HS256 JWT with payload `{ sub, iat, exp }`, 15-minute expiry.
- The signing secret comes from the `JWT_SECRET` environment variable. The client never sees it.
- Verification middleware:
  - Pins the algorithm to `HS256` explicitly. Never trusts the `alg` header.
  - Checks `exp`.
  - Returns 401 with a reason: `missing_token`, `invalid_signature`, `expired`, or `malformed`.
- Payload contains only `sub` and `exp`. Nothing sensitive, since JWT payloads are readable by anyone.

### Middleware order (important)

1. Auth check. Invalid token → 401. Does not touch the limiter.
2. Pick the limiter key: `sub` if authenticated and keyed by user, otherwise client IP.
3. Limiter `allow(key, now)`. Denied → 429 with `Retry-After`.
4. Route handler → 200.

Auth runs first so that forged or expired tokens can't drain a legitimate client's budget.

### Limiter Interface

Each limiter implements:

```
allow(key, now) → { allowed: boolean, retryAfterMs: number }
reset()
```

- **Fixed window:** one counter per key per window. Cheap. Allows up to 2× the limit in a burst straddling a window boundary.
- **Sliding window log:** stores timestamps per key and drops those outside the window. Accurate. Costs memory proportional to request volume.
- **Token bucket:** tokens refill at a steady rate up to capacity. Allows a controlled initial burst, then enforces the average rate.

### Keying Rules

- Login is always keyed by IP. Nobody is authenticated yet.
- Authenticated resource requests use `sub` when keyed by user, or IP when keyed by IP.
- The `X-Client-Id` header is **not** used. It let clients claim any identity, which is why it was replaced.

---

## 6. Frontend

### Attack Engine

- Each scenario is an array of events: `{ at, clientId, path, token? }`.
- The browser schedules each event with `setTimeout` relative to the start time.
- Each request uses `fetch` with an `Authorization` header when a token is present.
- Latency is measured with `performance.now()`.
- Response tally:
  - 200 → accepted
  - 429 → blocked
  - 401 → rejected auth (kept separate, never counted as a legitimate block)
- A legitimate block is a 429 on a request from a legitimate client.

### Clients and Tokens

- Legitimate clients log in once at round start and hold a token.
- Attacker clients either send no token, send forged tokens, or log in with their own accounts, depending on the scenario.
- Expired-token clients receive a token that's already expired (generated with a past `exp` in the demo scenario), so they produce a clean 401 with `expired`.

---

## 7. Scenarios

Five rounds, in order. Every round includes 2 to 3 legitimate clients so that "legitimate blocks" has meaning.

| Round | Name | What happens | What it teaches |
|---|---|---|---|
| 1 | Steady Flood | One unauthenticated client hammers `/api/resource` at a constant high rate. | Basic limiting. Any algorithm works. |
| 2 | Edge Exploit | One client sends a full quota just before a window boundary, then again just after. | Fixed window's double-burst weakness. |
| 3 | Burst Attack | One client sends 100 requests in about 5 seconds. | Token bucket's controlled burst vs. sliding window's strictness. |
| 4 | Credential Stuffing + Forged Tokens | Many attempts against `/api/login` from one IP, plus forged-signature and `alg: none` tokens against `/api/resource`. Includes one expired-token legitimate client. | Login needs its own limit. Auth must run before the limiter. |
| 5 | Account-Rotation Boss Wave | 50 accounts log in and each sends requests. Mixed with legitimate users. | Keying by user lets attackers multiply quota. Keying by IP catches it. |

**Round 5 is the one where the toggle matters most.** Make it the climax of the video.

**Cut list order:** slow drip (already removed), lives system, final summary screen, then the edge-exploit round. Don't cut auth.

---

## 8. Scoring

- Blocking attack traffic earns XP. Blocked attacker requests (429 or 401) count in your favor.
- Each legitimate block (429 on a legitimate client) costs XP.
- Legitimate clients rejected with 401 for an expired token are reported separately and don't cost XP. They're a client error, not a defense failure.
- Full XP (500 per round) requires zero legitimate blocks and attack traffic held near the configured limit.
- Partial XP scales with how close you get.

---

## 9. Project Structure

```
rate-limit-royale/
├── server/
│   ├── index.js              # Express app, routes, middleware order
│   ├── auth.js               # login, JWT sign, verify middleware
│   ├── users.js              # in-memory demo users
│   ├── limiters/
│   │   ├── fixedWindow.js
│   │   ├── slidingWindow.js
│   │   └── tokenBucket.js
│   └── README.md
├── client/
│   ├── src/
│   │   ├── App.jsx           # phase state machine
│   │   ├── scenarios.js      # five round scripts
│   │   ├── scheduler.js      # fires events, tallies results
│   │   └── components/       # Header, Briefing, Config, Results
│   └── vite.config.js        # proxy /api to Express
└── README.md                 # top-level: architecture and trade-offs
```

---

## 10. Build Plan (4 days)

**Day 1: Real backend (start here today)**
- Set up Express with `/api/health`, `/api/defense`, `/api/login`, and `/api/resource`.
- Implement the three limiters behind the same `allow()` interface.
- Implement JWT sign and verify with pinned `HS256`, and the 401 reasons.
- Wire the middleware order: auth → key selection → limiter → handler.
- Test with curl and a short Node script:
  - No token → 401.
  - Forged signature → 401, limiter count unchanged.
  - `alg: none` → 401.
  - Expired token → 401 with `expired`.
  - Valid token → 200, then 429 after the limit.
  - Fixed window allows the edge double burst. Token bucket allows the initial burst.
- **Done when:** the server returns the correct status for every case above, for all three algorithms.

**Day 2: Attack engine and game flow**
- Write the five scenario scripts as arrays of events.
- Build the scheduler: timed firing, latency tracking, 200/429/401 tally.
- Build the React phase state machine and wire the config panel, deploy button, and results card to real numbers. Skip styling.
- **Done when:** you can run rounds 1 through 5 and see accurate numbers from real requests.

**Day 3: Match the screenshot and add the toggle**
- Style the cards, algorithm selector, sliders, preview panel, and results card to match the sample.
- Add the header, XP bar, attack briefing card, and server status pill.
- Add the identity toggle (Key by IP / Key by user) and show the active keying mode in the preview.
- Add the 401 row to the results breakdown.
- Add loading and disabled states during firing.
- **Done when:** the full loop works from round 1 to round 5 and looks like the sample.

**Day 4: Boss wave, polish, and video**
- Make sure round 5 (account rotation) behaves differently under IP vs. user keying.
- Add result animations and a short final summary screen.
- Write the READMEs. Cover the three limiters' trade-offs, why login is keyed by IP, why authenticated requests are keyed by `sub`, and why auth runs before the limiter.
- Record a 2 to 5 minute video. Open with round 2 (edge exploit) to show the algorithm trade-off, then jump to round 5 for the keying argument.

---

## 11. Interview Points to Prepare

- **Algorithm trade-offs:** fixed window's boundary burst, sliding log's memory cost, token bucket's burst allowance. Be able to state which you'd pick for a public API and why.
- **Pinned algorithm:** why `jsonwebtoken` should be called with `algorithms: ["HS256"]`, and what `alg: none` would allow otherwise.
- **Middleware ordering:** why auth runs before the limiter, so invalid tokens don't drain a client's budget.
- **Keying strategy:** keyed by IP breaks down behind shared NATs and proxies (remember `trust proxy`). Keyed by user is spoofable if an attacker can create accounts. Most systems combine both.
- **JWT revocation:** tokens can't be revoked before expiry without a server-side denylist. Short-lived access tokens plus refresh tokens is the usual trade-off.
- **Honest limits:** the `X-Client-Id` shortcut is gone, but the demo still uses in-memory state, so it won't work across multiple server instances. Say this before the interviewer asks.
- **Measured results:** replace the "example data" in the screenshot with real values from your first run, so every number in the video came from the server.

---

## 12. Definition of Done

- All three limiters pass the Day 1 curl checks.
- Five rounds run end to end with real request results.
- Keying toggle changes the outcome of round 5.
- 401s are reported separately from 429s and never count as legitimate blocks.
- READMEs explain every trade-off listed in section 11.
- A 2 to 5 minute video is recorded with a live round shown.