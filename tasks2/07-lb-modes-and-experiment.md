# 07: Load-balancing modes + the experiment

## Goal
Produce the matrix from the README with real numbers, plus the sticky-routing failure case.

## Steps
1. `scripts/experiment.ts` (`npm run experiment`) runs every combination via `npm run cluster`, restarting between them:
   `{ round-robin, sticky } × { memory, redis }`
   - For each combination: round 5 keyed by IP, round 4 (login lockout), and round 1.
   - It records the attacker-passed count, login failures before lockout, legit blocks, and the per-node request split.
2. **Sticky failure case:** in `sticky + memory`, kill the node serving the attacker's IP halfway through round 5.
   NGINX moves the IP to another node, where the attacker gets a fresh budget. Show the passed count jump.
3. Print one markdown table ready to paste into the README.

## What to expect (and say)
| | memory | redis |
|---|---|---|
| round robin | ~3× leak, login 15 failures | 1×, login 5 |
| sticky (hash on client IP) | ~1×, looks fixed | 1× |
| sticky, node killed mid-round | attacker gets a fresh budget | 1× (state survives in Redis) |

The lesson: **sticky routing hides the shared-state problem but doesn't solve it.** It also brings uneven load (a
NAT'd office lands entirely on one node), and with key-by-user, a user who changes IP gets a new node and a new budget.

## Acceptance criteria
- `npm run experiment` finishes on its own (a few minutes) and prints the table. Every run's summed stats match the replay tally.
