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

    test("simulated client IP survives the NGINX hop", async () => {
      const res = await fetch(`${cluster.lbUrl}/api/demo/whoami`, { headers: { "X-Forwarded-For": "10.0.0.7" } });
      assert.deepEqual(await res.json(), { ip: "10.0.0.7" });
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
