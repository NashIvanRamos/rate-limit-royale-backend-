# 00: Local infra (Redis, NGINX, cluster runner)

## Goal
One command brings up NGINX on `:8080` in front of 3 nodes (`:3001–3003`), plus Redis on `:6379` when needed.
No Docker, no `sudo`, no global config changes.

## Steps
1. **Install** (one time): `brew install redis nginx`.
2. **Node identity:** add a `NODE_ID` env var (default `"single"`). Include it in the `/api/health` and `/api/stats`
   responses and in an `X-Node-Id` response header, so the replay can show which node served each request.
3. **NGINX configs** in `infra/nginx/`:
   - `common.conf`: `listen 127.0.0.1:8080`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`,
     `proxy_set_header Host $host`, short timeouts, and `pid`/log paths inside `infra/nginx/run/` (git-ignored).
   - `round-robin.conf`: `upstream api { server 127.0.0.1:3001; server 127.0.0.1:3002; server 127.0.0.1:3003; }`
   - `sticky.conf`: same, plus `hash $http_x_forwarded_for consistent;`
     - **Not `ip_hash`.** `ip_hash` hashes the TCP peer address, and every simulated client connects from
       127.0.0.1, so everything would land on one node. Locally, the simulated identity lives in `X-Forwarded-For`.
       (In production you'd hash on the real client address.)
     - Also, `ip_hash` only uses the first three octets of an IPv4 address, so `10.0.0.1` and `10.0.0.2` would always
       share a node. Worth mentioning as a NAT-style footgun.
4. **`scripts/cluster.ts`** (`npm run cluster -- --lb round-robin|sticky --store memory|redis`):
   - If the store is `redis`, start `redis-server --port 6379 --save "" --appendonly no`.
   - Start 3 nodes (`PORT=300N NODE_ID=node-N LIMITER_STORE=… REDIS_URL=…`).
   - Start `nginx -p infra/nginx -c <lb>.conf -g "daemon off;"`.
   - Prefix each process's output (`[node-1]`, `[nginx]`, `[redis]`), wait for every `/api/health`, and stop
     everything on Ctrl+C.
   - Restarting with a different `--lb` or `--store` is the "toggle".
5. **Optional `docker-compose.yml`:** the same topology for anyone who prefers Docker. It needs Docker Desktop running,
   and is not on the critical path.

## Tests / checks
- `curl localhost:8080/api/health` repeated 6 times shows `node-1, node-2, node-3, node-1, …` (round robin).
- In sticky mode, the same `X-Forwarded-For` always gets the same `nodeId`, and different IPs spread across nodes.
- `/api/demo/whoami` through NGINX with `X-Forwarded-For: 10.0.0.7` returns `10.0.0.7` (`trust proxy` still correct).

## Acceptance criteria
- `npm run cluster` starts in under 5s and Ctrl+C leaves no stray processes.
- `npm run dev` (single node on `:3000`) is unchanged.
