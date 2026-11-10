# 09: Scenario support and backend replays

## Goal
Prove from the backend side that each of the five rounds (doc §7) produces the intended lesson,
especially that **the keying toggle changes the outcome of round 5** (doc §12). It also gives the
frontend a reference shape for scenario events.

## Shared scenario shape (`src/scenarios/types.ts`, exported for the frontend to copy)
```ts
interface ClientSpec { id: string; ip: string; legit: boolean;
  auth: "none" | "login" | "forged" | "algNone" | "expired"; username?: string }
interface ScenarioEvent { at: number; clientId: string; path: "/api/resource" | "/api/login"; body?: unknown }
interface Scenario { id: number; name: string; description: string; clients: ClientSpec[];
  durationMs: number; events: ScenarioEvent[] }
```
Every scenario includes 2 to 3 legitimate clients (`alice`, `bob`, `carol` on their own IPs).

## Replay runner (`scripts/replay.ts`, `npm run replay -- --round 5 --keyBy ip`)
Node equivalent of the browser scheduler: deploys a config, performs logins, fires events on
schedule with `X-Forwarded-For` per client, and tallies accepted/blocked/rejectedAuth/legitBlocks,
then compares with `GET /api/stats`. The browser engine can be checked against it.

## Per-round expectations to assert (`test/scenarios.test.ts`, time-compressed windows)
1. **Steady Flood.** Any algorithm blocks most attacker traffic with 0 legit blocks.
2. **Edge Exploit.** With fixed window the attacker gets ≈2× quota across the boundary. With sliding it gets ≤1×.
   Needs `windowEpochMs` (task 02).
3. **Burst Attack.** Token bucket admits the initial `capacity` burst and then the refill rate. Sliding admits exactly `max` per window.
4. **Credential Stuffing + Forged Tokens.** Login stuffing from one IP hits 429 after the failure budget.
   Forged and `alg: none` → 401 and don't affect alice/bob. The expired-token legit client → 401 `expired`, counted
   as rejectedAuth, **not** a legit block.
5. **Account-Rotation Boss Wave.** 50 pool accounts log in (all 200, since failure-only login limiting
   allows it) from one attacker IP and fire requests.
   - `keyBy: "user"` → attacker gets ~50× quota (most requests 200).
   - `keyBy: "ip"` → attacker capped at 1× quota. Legit users on their own IPs are unaffected.
   - Assert: `accepted(attacker, user) >= 10 × accepted(attacker, ip)`.

## Acceptance criteria
- Round 5 replay output clearly differs between `ip` and `user` keying.
- 401s never appear in `legitBlocks` in any round.
- Replay numbers match `/api/stats` exactly.

## Note on scoring (doc §8)
Scoring stays frontend-side, but the replay runner includes a reference `score(results, config)`
so the formula can be tested once and copied:
XP = 500 × clamp(attackBlockedRatio vs. ideal) − penalty × legitBlocks, where 401 on legit clients isn't
penalised. The exact coefficients are open and get tuned once real numbers are in.
