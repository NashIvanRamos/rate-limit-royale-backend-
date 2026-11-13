/**
 * Local cluster (tasks2/00): NGINX + 3 real node processes. Skipped when nginx isn't installed.
 * Uses ports 13001-13003 and 18080 so it can't collide with `npm run cluster` (3001-3003, 8080) or `npm run dev`.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderNginxConf, startCluster, type Cluster, type LbMode } from "../scripts/cluster.js";

const hasNginx = spawnSync("which", ["nginx"]).status === 0;

async function nodeOf(url: string, ip?: string): Promise<string> {
  const res = await fetch(`${url}/api/health`, { headers: ip ? { "X-Forwarded-For": ip } : {} });
  await res.body?.cancel();
  assert.equal(res.status, 200);
  return res.headers.get("x-node-id")!;
}

describe("nginx config rendering", () => {
  test("round robin vs. sticky (hash on X-Forwarded-For, never ip_hash)", () => {
    const rr = renderNginxConf({ lbPort: 8080, ports: [3001, 3002], lb: "round-robin" });
    const sticky = renderNginxConf({ lbPort: 8080, ports: [3001, 3002], lb: "sticky" });
    for (const conf of [rr, sticky]) {
      assert.ok(!conf.includes("{{"), "every placeholder replaced");
      assert.match(conf, /listen 127\.0\.0\.1:8080;/);
      assert.match(conf, /server 127\.0\.0\.1:3001 .*;\n\s+server 127\.0\.0\.1:3002 /);
    }
    assert.ok(!/^\s*hash /m.test(rr));
    assert.match(sticky, /^\s*hash \$http_x_forwarded_for consistent;/m);
    assert.ok(!/^\s*ip_hash/m.test(sticky));
  });
});

const hasRedis = spawnSync("which", ["redis-server"]).status === 0;

for (const lb of ["round-robin", "sticky"] as LbMode[]) {
  describe(`cluster: ${lb}`, { skip: hasNginx ? false : "nginx not installed (brew install nginx)" }, () => {
    let cluster: Cluster;
    before(async () => {
      cluster = await startCluster({ lb, basePort: 13001, lbPort: 18080 });
    });
    after(() => cluster?.stop());

    test("every node is up and reports its own id", async () => {
      const ids = await Promise.all(cluster.nodeUrls.map((u) => nodeOf(u)));
      assert.deepEqual(ids, ["node-1", "node-2", "node-3"]);
    });

    test("through NGINX, X-Node-Port is the node port it routed to (tasks2/10)", async () => {
      const seen = new Map<string, string>();
      for (let i = 0; i < 9; i++) {
        const res = await fetch(`${cluster.lbUrl}/api/health`, { headers: { "X-Forwarded-For": `10.0.2.${i}` } });
        await res.body?.cancel();
        seen.set(res.headers.get("x-node-id")!, res.headers.get("x-node-port")!);
      }
      for (const [id, port] of seen) assert.equal(port, String(13000 + Number(id.replace("node-", ""))), `${id} → :${port}`);
    });

    test("simulated client IP survives the NGINX hop", async () => {
      const res = await fetch(`${cluster.lbUrl}/api/demo/whoami`, { headers: { "X-Forwarded-For": "10.0.0.7" } });
      assert.deepEqual(await res.json(), { ip: "10.0.0.7" });
    });

    test(`the leak, measured: 30 requests from one IP at "5 per minute" → ${lb === "round-robin" ? "15 (5 per node)" : "5"} allowed`, async () => {
      // State is per node, so deploy to every node directly (a deploy through NGINX would reach only one).
      const config = { algorithm: "fixed", maxRequests: 5, windowMs: 60_000, keyBy: "ip" };
      for (const url of cluster.nodeUrls) {
        const res = await fetch(`${url}/api/defense`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
        assert.equal(res.status, 200);
      }
      const login = await fetch(`${cluster.lbUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.6.6.6" },
        body: JSON.stringify({ username: "user01", password: "pass-user01" }),
      });
      const { token } = (await login.json()) as { token: string };
      let allowed = 0;
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${cluster.lbUrl}/api/resource`, { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "10.6.6.6" } });
        await res.body?.cancel();
        if (res.status === 200) allowed++;
      }
      assert.equal(allowed, lb === "round-robin" ? 3 * config.maxRequests : config.maxRequests);
    });

    if (lb === "round-robin") {
      test("requests from one client rotate across all nodes", async () => {
        const seen: string[] = [];
        for (let i = 0; i < 9; i++) seen.push(await nodeOf(cluster.lbUrl, "10.0.0.7"));
        assert.deepEqual(new Set(seen), new Set(["node-1", "node-2", "node-3"]));
        for (const id of ["node-1", "node-2", "node-3"]) assert.equal(seen.filter((s) => s === id).length, 3);
      });
    } else {
      test("one client always lands on the same node; many clients spread out", async () => {
        const same = new Set<string>();
        for (let i = 0; i < 6; i++) same.add(await nodeOf(cluster.lbUrl, "10.0.0.7"));
        assert.equal(same.size, 1);

        const spread = new Set<string>();
        for (let i = 1; i <= 30; i++) spread.add(await nodeOf(cluster.lbUrl, `10.0.1.${i}`));
        assert.equal(spread.size, 3);
      });
    }
  });
}

describe("cluster: round-robin + redis", { skip: hasNginx && hasRedis ? false : "needs nginx and redis-server" }, () => {
  let cluster: Cluster;
  before(async () => {
    cluster = await startCluster({ lb: "round-robin", store: "redis", basePort: 13011, lbPort: 18081, redisPort: 16390 });
  });
  after(() => cluster?.stop());

  test("the leak, fixed: 30 requests from one IP at 5 per minute → exactly 5 allowed across 3 nodes", async () => {
    // One deploy through the load balancer is enough: the config is shared.
    const deploy = await fetch(`${cluster.lbUrl}/api/defense`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ algorithm: "fixed", maxRequests: 5, windowMs: 60_000, keyBy: "ip" }),
    });
    assert.equal(deploy.status, 200);
    const login = await fetch(`${cluster.lbUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.6.6.6" },
      body: JSON.stringify({ username: "user01", password: "pass-user01" }),
    });
    const { token } = (await login.json()) as { token: string };
    const served = new Set<string>();
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${cluster.lbUrl}/api/resource`, { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "10.6.6.6" } });
      await res.body?.cancel();
      served.add(res.headers.get("x-node-id")!);
      if (res.status === 200) allowed++;
    }
    assert.equal(served.size, 3, "traffic really was spread over 3 nodes");
    assert.equal(allowed, 5);
  });

  test("login lockout is cluster-wide: 5 failures, then 429 (15 without Redis)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${cluster.lbUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.6.6.99" },
        body: JSON.stringify({ username: "user02", password: "wrong" }),
      });
      await res.body?.cancel();
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429, 429]);
  });

  test("per-round toggle in ONE cluster run: memory round leaks ~3x, redis round doesn't (tasks2/09)", async () => {
    const login = await fetch(`${cluster.lbUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.6.6.7" },
      body: JSON.stringify({ username: "user03", password: "pass-user03" }),
    });
    const { token } = (await login.json()) as { token: string };
    const results: Record<string, { allowed: number; lockoutAfter: number }> = {};
    for (const limiterStore of ["memory", "redis", "memory"] as const) {
      const deploy = await fetch(`${cluster.lbUrl}/api/defense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ algorithm: "fixed", maxRequests: 5, windowMs: 60_000, keyBy: "ip", limiterStore }),
      });
      assert.equal(deploy.status, 200);
      let allowed = 0;
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${cluster.lbUrl}/api/resource`, { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "10.6.6.7" } });
        await res.body?.cancel();
        if (res.status === 200) allowed++;
      }
      let lockoutAfter = 0;
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${cluster.lbUrl}/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.6.6.8" },
          body: JSON.stringify({ username: "user04", password: "wrong" }),
        });
        await res.body?.cancel();
        if (res.status === 401) lockoutAfter++;
      }
      results[limiterStore] = { allowed, lockoutAfter };
      assert.deepEqual(results[limiterStore], limiterStore === "memory" ? { allowed: 15, lockoutAfter: 15 } : { allowed: 5, lockoutAfter: 5 });
    }
  });
});
