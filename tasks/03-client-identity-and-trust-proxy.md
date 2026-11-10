# 03: Client identity and simulated IPs

## Goal
Derive a trustworthy client IP for keying. Since the game runs every simulated client from one
browser, give the frontend a *controlled* way to simulate distinct IPs without reintroducing the
`X-Client-Id` hole the doc removed (doc §5 Keying Rules, §11 "remember `trust proxy`").

## Problem
Every request from the browser arrives from `127.0.0.1` (or `::1`). With "Key by IP" all
legitimate users and attackers would share one bucket, and the "client IPs" stat tile and round 5
would be meaningless.

## Approach
- Use Express's `req.ip` exclusively. Never read headers by hand.
- `app.set("trust proxy", env.TRUST_PROXY)` with default `"loopback"`. Express then honours
  `X-Forwarded-For` **only when the immediate peer is loopback** (the Vite dev proxy / local browser).
  A remote caller can't spoof its IP, because their peer address isn't trusted.
- The frontend attack engine sets `X-Forwarded-For: 10.0.0.<n>` per simulated client.
  The Vite proxy (`xfwd: true`) appends `127.0.0.1`. Express walks right to left, skips the trusted
  loopback hop, and resolves `req.ip = 10.0.0.<n>`.
- `src/middleware/clientIp.ts` exports `getClientKeyIp(req)` that normalises IPv4-mapped IPv6
  (`::ffff:127.0.0.1` → `127.0.0.1`) and falls back to `"unknown"`.
- `TRUST_PROXY=false` disables simulation entirely (real-IP mode).

## Why this isn't `X-Client-Id` again
`X-Client-Id` was trusted from anyone. Here the forwarded header is trusted **only from a
configured proxy hop**, which is exactly how production deployments behind a load balancer work.
The README must say plainly that this is a simulation affordance for a local demo.

## Tests (`test/clientIp.test.ts`)
- Local request with `X-Forwarded-For: 10.0.0.7` → key IP `10.0.0.7`.
- Chain `X-Forwarded-For: 1.2.3.4, 10.0.0.7` from loopback → `10.0.0.7` (rightmost untrusted, not leftmost).
- With `TRUST_PROXY=false` the header is ignored and the key is the socket address.
- IPv6-mapped address is normalised.

## Acceptance criteria
- Two requests with different `X-Forwarded-For` values hit different limiter keys under `keyBy: "ip"`.
- No code path reads `X-Client-Id` or parses `X-Forwarded-For` manually.

## Frontend dependency (note for client work)
- Scenario clients need a stable `ip` field. Vite proxy config needs `xfwd: true`.
- If the frontend calls the API directly (no proxy), CORS already allows `X-Forwarded-For` (task 00).
