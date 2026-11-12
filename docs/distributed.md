# Distributed mode: measured results

Running log of real numbers from `npm run cluster` + `npm run replay -- --cluster`. Folded into the README in tasks2/08.
Defense: fixed window, 10 per 10s, key by IP. Single-node numbers are from the README's measured results.

## Before Redis: 3 nodes, round robin, in-memory state (tasks2/01)

| | Single node | 3 nodes, round robin | Why |
|---|---|---|---|
| Round 5 (account rotation): attacker requests through | 13 | **33** | each node gives the attacker IP its own 10 |
| Round 1 (steady flood): attacker requests through | 12 | **32** | same |
| Round 4 (stuffing): failed logins before lockout | 5 | **15** | the login lockout is per node too |

Traffic split evenly (round 5: node-1 106, node-2 107, node-3 107). The server's summed `/api/stats` matched
the replay's tally exactly in every run. Legit blocks stayed at 0, so the leak only helps the attacker.

Also covered by `test/cluster.test.ts`: 30 requests from one IP at "5 per minute" → 15 allowed with round robin,
5 with sticky routing.

## Redis step 1: shared config and stats, counters still per node (tasks2/03)

`npm run cluster -- --store redis`:
- One `POST /api/defense` through the load balancer: all 3 nodes report the same config and the same `deployedAt`
  (one shared window epoch).
- `/api/stats` from **any one** node equals the whole cluster's tally (the replay matched it exactly).
- Round 5: still **33** through, as expected. The limiter counters themselves are per node until tasks2/04.

## Redis step 2: limiter counters in Redis, atomic Lua (tasks2/04)

`npm run cluster -- --store redis`, round robin, same defense:

| | Single node | 3 nodes, memory | 3 nodes, Redis |
|---|---|---|---|
| Round 5: attacker requests through | 13 | 33 | **13** |
| Round 1: attacker requests through | 12 | 32 | **12** |
| Round 4: failed logins before lockout | 5 | 15 | **5** (after tasks2/05) |

Back to exactly the single-node numbers. The login row was 15 until tasks2/05 moved the lockout to Redis
(sliding-log script in peek mode for the check). Measured after: 60 stuffing attempts → 5 × 401, then 55 × 429. Traffic was still split evenly over the 3 nodes, and `/api/stats` matched.

Proof that atomicity matters (`test/redisLimiters.test.ts`):
- 50 concurrent requests at a limit of 10 → **exactly 10** allowed by each Lua limiter.
- The same 50 through a naive GET-then-INCR limiter → **50 of 50** allowed. All 50 reads happen before any write.
- Differential test: 600 random requests through the in-memory limiter and the Redis store give identical decisions
  (allowed, retryAfterMs, remaining) for all three algorithms.
