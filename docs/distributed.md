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

## After Redis limiters

Pending tasks2/04–05.
