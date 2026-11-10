import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createLimiter } from "../src/algorithms/index.js";
import { getClientKeyIp, normalizeIp } from "../src/middleware/clientIp.js";
import { startServer, testEnv, type TestServer } from "./helpers/server.js";

async function whoami(server: TestServer, xff?: string): Promise<string> {
  const res = await fetch(`${server.baseUrl}/api/demo/whoami`, {
    headers: xff === undefined ? {} : { "X-Forwarded-For": xff },
  });
  assert.equal(res.status, 200);
  return (await res.json()).ip;
}

describe("normalizeIp", () => {
  test("unwraps IPv4-mapped IPv6", () => {
    assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeIp("::FFFF:10.0.0.7"), "10.0.0.7");
  });
  test("leaves other addresses alone", () => {
    assert.equal(normalizeIp("10.0.0.7"), "10.0.0.7");
    assert.equal(normalizeIp("::1"), "::1");
    assert.equal(normalizeIp("2001:DB8::1"), "2001:db8::1");
  });
});

describe("client IP with TRUST_PROXY=loopback (default)", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer(testEnv());
  });
  after(() => server.close());

  test("no header → socket address", async () => {
    assert.equal(await whoami(server), "127.0.0.1");
  });

  test("X-Forwarded-For from loopback → simulated IP", async () => {
    assert.equal(await whoami(server, "10.0.0.7"), "10.0.0.7");
  });

  test("chain resolves to the rightmost untrusted hop, not the leftmost", async () => {
    assert.equal(await whoami(server, "1.2.3.4, 10.0.0.7"), "10.0.0.7");
  });

  test("trusted loopback hops in the chain are skipped (Vite proxy appends 127.0.0.1)", async () => {
    assert.equal(await whoami(server, "10.0.0.7, 127.0.0.1"), "10.0.0.7");
  });

  test("junk X-Forwarded-For falls back to the socket address", async () => {
    assert.equal(await whoami(server, "not-an-ip"), "127.0.0.1");
  });

  test("IPv6 simulated address is preserved and normalised", async () => {
    assert.equal(await whoami(server, "2001:DB8::1"), "2001:db8::1");
  });
});

describe("client IP when the peer is NOT a trusted proxy", () => {
  test("TRUST_PROXY=false ignores X-Forwarded-For", async () => {
    const server = await startServer(testEnv({ TRUST_PROXY: "false" }));
    try {
      assert.equal(await whoami(server, "10.0.0.7"), "127.0.0.1");
    } finally {
      await server.close();
    }
  });

  test("a remote caller can't spoof: loopback untrusted, header ignored", async () => {
    // Trust only a subnet the test client isn't in. The loopback peer then acts like a remote client.
    const server = await startServer(testEnv({ TRUST_PROXY: "192.168.250.0/24" }));
    try {
      assert.equal(await whoami(server, "10.0.0.7"), "127.0.0.1");
    } finally {
      await server.close();
    }
  });
});

describe("demo endpoint gating", () => {
  test("/api/demo/whoami is 404 when DEMO_MODE=false", async () => {
    const server = await startServer(testEnv({ DEMO_MODE: "false" }));
    try {
      const res = await fetch(`${server.baseUrl}/api/demo/whoami`);
      assert.equal(res.status, 404);
    } finally {
      await server.close();
    }
  });
});

describe("IP keying with a limiter", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    // Minimal app: limit of 1 per key, keyed by getClientKeyIp. Proves distinct simulated IPs get distinct budgets.
    const app = express();
    app.set("trust proxy", "loopback");
    const limiter = createLimiter("fixed", { maxRequests: 1, windowMs: 60_000 });
    app.get("/r", (req, res) => {
      const d = limiter.allow(`ip:${getClientKeyIp(req)}`, Date.now());
      res.status(d.allowed ? 200 : 429).end();
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const hit = async (ip: string) =>
    (await fetch(`${baseUrl}/r`, { headers: { "X-Forwarded-For": ip } })).status;

  test("different X-Forwarded-For values hit different limiter keys", async () => {
    assert.equal(await hit("10.0.0.1"), 200);
    assert.equal(await hit("10.0.0.1"), 429);
    assert.equal(await hit("10.0.0.2"), 200);
  });
});
