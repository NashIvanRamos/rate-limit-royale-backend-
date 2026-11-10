# 07: Server-side stats (verification)

## Goal
The doc's pitch is "the numbers come from the server, so they can be verified live" (§1, §11
"Measured results"). Give the server its own tally so the frontend's results card can be
cross-checked against ground truth, and the video can show both matching.

## Design
- `src/middleware/stats.ts`: on `res.on("finish")`, increment counters for `/api/resource` and `/api/login`:
  ```ts
  { since: number,
    resource: { total, s200, s429, s401, byReason: { missing_token, invalid_signature, expired, malformed } },
    login:    { total, s200, s401, s429, s400 },
    trackedKeys: number }          // limiter.size() at read time (sliding-log memory talking point)
  ```
- Reset on `POST /api/defense` (each round starts at zero).
- `GET /api/stats` returns the snapshot. Not limited and not counted.
- Optional: per-key breakdown `topKeys` (top 10 by requests) to show round 5's 50 user keys vs. 1 IP key.

## Tests (`test/stats.test.ts`)
- After a mixed burst (200s, 401s with different reasons, 429s) the counts match exactly.
- Deploy resets the stats. Stats and health calls aren't counted.

## Acceptance criteria
- For any run, `s200 + s429 + s401 === total` for resource (no 5xx in normal play).
- Frontend results can display "server confirms: …" next to client tallies.

## Notes
- The server can't know which clients are "legitimate". That label lives in the scenario script,
  so `legitBlocks` stays client-computed. Say so in the README.
