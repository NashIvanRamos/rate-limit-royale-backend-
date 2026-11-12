# 08: README update

## Goal
Turn the measured experiment into the story, in the project README.

## Changes
- **Honest limits:** "in-memory state" now links to the new section rather than ending the story.
- New section, **"Scaling out: 3 nodes"**:
  - The topology diagram, and how to run it (`npm run cluster`, `npm run experiment`).
  - The measured matrix from task 07.
  - Why Lua (with the concurrency test as proof), the generation-prefix reset, app clock vs. Redis `TIME`, fail open vs.
    fail closed (and why login always fails closed), and sticky routing vs. shared state.
- Update "What I'd change for production" to cover only what's still not done: managed Redis with replicas,
  `TIME`-based clocks, pub/sub config caching, and metrics.

## Acceptance criteria
- Every number in the new section comes from a real `npm run experiment` run.
- Someone can go from a clean clone to the experiment table by following the README alone.
