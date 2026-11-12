# 05: Redis login guard

## Goal
Login failures are counted cluster-wide. Without this, a credential stuffer gets 5 failures **per node** (15 through
a 3-node round robin).

## Design
- `LoginGuard` gets the same split as the limiters: a memory version (today's) and a Redis version on the sliding-log
  script, keyed `login:<gen>:<ip>`.
- `check()` needs a **peek** (decide without recording). Add a `peek` flag to the sliding-log script rather than
  writing a second script.
- Same generation prefix, so a deploy still clears lockouts.

## Tests
- Round 4 through the cluster with Redis: exactly 5 × 401, then 429. With Redis off it's up to 15 (keep that as the
  measured "before" from task 01).

## Acceptance criteria
- Login lockout behaves identically on 1 node and on 3 nodes with Redis.
