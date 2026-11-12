# 01: Measure the leak (Redis off)

## Goal
Prove the problem before fixing it: through a round-robin load balancer, in-memory limiting lets ~3× through.

## The catch first: everything is per node
With Redis off, each node has its own defense config, limiter, login guard and stats. So:
- `POST /api/defense` through NGINX reaches **one** node. The other two keep the old config.
- `GET /api/stats` through NGINX shows **one** node's numbers.

For this experiment, the replay tool talks to the nodes directly for control traffic. Only attack traffic goes through NGINX.

## Steps
1. Add `--nodes http://localhost:3001,http://localhost:3002,http://localhost:3003` to `npm run replay`:
   - **Deploy** to every node (in parallel, before setup).
   - **Fire** all events at `BASE_URL` (NGINX, `:8080`).
   - **Stats:** fetch from every node and **sum** them before the `/api/stats` cross-check (`compareWithStats`
     works unchanged on the summed snapshot).
   - Record `X-Node-Id` per request, and print the split (for example `node-1: 107, node-2: 107, node-3: 106`).
2. Run the matrix with Redis off:
   - Round 5 keyed by IP (10 per 10s), round robin → expect ~30 attacker requests through, not 10.
   - Round 4 → expect up to **15** login failures before lockout (5 per node), not 5.
   - Round 1 → expect ~3× attacker passes.
3. Save the outputs. These are the "before" numbers for the README.

## Notes
- Each node's fixed window is aligned to its *own* deploy time. With parallel deploys they differ by a few ms. Mention
  it, since it's one more piece of state that has to be shared (task 03 fixes it).
- Round 2's boundary maths assumes one epoch. With 3 nodes it uses node 1's epoch. That's fine for this experiment.

## Acceptance criteria
- The replay output shows the per-node split, and the attacker-passed count is ~3× the single-node baseline in the README.
- The summed stats still match the replay tally exactly.
