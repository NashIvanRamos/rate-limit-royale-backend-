import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { classifyJwtError, signAccessToken, signExpiredToken, verifyAccessToken } from "../src/auth/jwt.js";
import { authenticate, extractBearerToken } from "../src/middleware/authenticate.js";
import { fakeClock, TEST_SECRET } from "./helpers/server.js";
import * as tokens from "./helpers/tokens.js";

const clock = fakeClock();

describe("extractBearerToken", () => {
  test("extracts the token", () => {
    assert.equal(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
    assert.equal(extractBearerToken("bearer abc"), "abc", "scheme is case-insensitive");
    assert.equal(extractBearerToken("  Bearer   abc  "), "abc");
  });
  test("returns null for missing / wrong scheme / empty token", () => {
    for (const h of [undefined, "", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Token abc", "abc", "Bearer a b"]) {
      assert.equal(extractBearerToken(h), null, JSON.stringify(h));
    }
  });
});

describe("verifyAccessToken", () => {
  const now = clock.now();
  const verify = (t: string) => verifyAccessToken(TEST_SECRET, t, now);
  const reasonOf = (t: string) => {
    const r = verify(t);
    return r.ok ? "OK" : r.reason;
  };

  test("accepts tokens issued by signAccessToken", () => {
    const r = verify(signAccessToken(TEST_SECRET, "alice", now));
    assert.deepEqual(r, { ok: true, claims: { sub: "alice", exp: Math.floor(now / 1000) + 900 } });
  });

  test("invalid_signature: forged, tampered, alg none (both forms), wrong algorithm", () => {
    assert.equal(reasonOf(tokens.forgeSignature("alice", now)), "invalid_signature");
    assert.equal(reasonOf(tokens.tamperPayload(tokens.validToken("alice", now), "bob")), "invalid_signature");
    assert.equal(reasonOf(tokens.algNone("alice", now)), "invalid_signature");
    assert.equal(reasonOf(tokens.algNoneWithSignature("alice", now)), "invalid_signature");
    assert.equal(reasonOf(tokens.wrongAlgorithm("alice", now)), "invalid_signature");
  });

  test("expired: correctly signed token past exp (including the demo endpoint's token)", () => {
    assert.equal(reasonOf(tokens.expired("alice", now)), "expired");
    assert.equal(reasonOf(signExpiredToken(TEST_SECRET, "carol", now)), "expired");
  });

  test("a forged AND expired token reports invalid_signature, not expired", () => {
    assert.equal(reasonOf(tokens.expiredForged("alice", now)), "invalid_signature");
  });

  test("token becomes expired exactly at exp", () => {
    const t = signAccessToken(TEST_SECRET, "alice", now);
    assert.equal(verifyAccessToken(TEST_SECRET, t, now + 899_000).ok, true);
    const r = verifyAccessToken(TEST_SECRET, t, now + 900_000);
    assert.equal(r.ok ? "OK" : r.reason, "expired");
  });

  test("malformed: garbage and structurally broken tokens", () => {
    for (const t of tokens.GARBAGE_TOKENS) assert.equal(reasonOf(t), "malformed", t);
    assert.equal(reasonOf("x".repeat(5000)), "malformed");
  });

  test("malformed: validly signed but wrong payload shape", () => {
    const exp = Math.floor(now / 1000) + 900;
    assert.equal(reasonOf(tokens.signedPayload("just a string", now)), "malformed");
    assert.equal(reasonOf(tokens.signedPayload({ exp }, now)), "malformed", "no sub");
    assert.equal(reasonOf(tokens.signedPayload({ sub: "", exp }, now)), "malformed", "empty sub");
    assert.equal(reasonOf(tokens.signedPayload({ sub: 42, exp }, now)), "malformed", "numeric sub");
    assert.equal(reasonOf(tokens.signedPayload({ sub: "alice" }, now)), "malformed", "no exp");
  });

  test("classifyJwtError fails closed on unknown errors", () => {
    assert.equal(classifyJwtError(new Error("boom")), "malformed");
    assert.equal(classifyJwtError("not an error"), "malformed");
    assert.equal(classifyJwtError(new jwt.NotBeforeError("jwt not active", new Date())), "malformed");
  });
});

describe("authenticate middleware over HTTP", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.get("/protected", authenticate({ secret: TEST_SECRET, now: clock.now }), (req, res) => {
      res.json({ auth: req.auth });
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (authorization?: string) =>
    fetch(`${baseUrl}/protected`, { headers: authorization === undefined ? {} : { Authorization: authorization } });

  async function expect401(authorization: string | undefined, reason: string) {
    const res = await call(authorization);
    assert.equal(res.status, 401, `${authorization} → ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { error: "unauthorized", reason });
    const www = res.headers.get("www-authenticate") ?? "";
    assert.match(www, /^Bearer realm=/);
    if (reason === "missing_token") assert.ok(!www.includes("error="), www);
    else assert.ok(www.includes(`error="invalid_token"`) && www.includes(`error_description="${reason}"`), www);
    return body;
  }

  test("valid token → 200 and req.auth = { sub, exp }", async () => {
    const now = clock.now();
    const res = await call(`Bearer ${signAccessToken(TEST_SECRET, "alice", now)}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).auth, { sub: "alice", exp: Math.floor(now / 1000) + 900 });
  });

  test("missing_token: no header, empty header, wrong scheme, scheme without token", async () => {
    await expect401(undefined, "missing_token");
    await expect401("", "missing_token");
    await expect401("Basic dXNlcjpwYXNz", "missing_token");
    await expect401("Bearer", "missing_token");
  });

  test("invalid_signature: forged, tampered, alg none, wrong algorithm", async () => {
    const now = clock.now();
    for (const t of [
      tokens.forgeSignature("alice", now),
      tokens.tamperPayload(tokens.validToken("alice", now), "bob"),
      tokens.algNone("alice", now),
      tokens.algNoneWithSignature("alice", now),
      tokens.wrongAlgorithm("alice", now),
      tokens.expiredForged("alice", now),
    ]) {
      await expect401(`Bearer ${t}`, "invalid_signature");
    }
  });

  test("expired", async () => {
    await expect401(`Bearer ${tokens.expired("alice", clock.now())}`, "expired");
  });

  test("malformed", async () => {
    for (const t of tokens.GARBAGE_TOKENS) await expect401(`Bearer ${t}`, "malformed");
    await expect401(`Bearer ${tokens.signedPayload({ exp: 9_999_999_999 }, clock.now())}`, "malformed");
  });

  test("401 responses never echo the token", async () => {
    const t = tokens.forgeSignature("alice", clock.now());
    const res = await call(`Bearer ${t}`);
    const raw = JSON.stringify(await res.json()) + (res.headers.get("www-authenticate") ?? "");
    assert.ok(!raw.includes(t));
  });

  test("every 401 reason is one of exactly four values", async () => {
    const now = clock.now();
    const seen = new Set<string>();
    for (const h of [
      undefined,
      "Bearer abc",
      `Bearer ${tokens.forgeSignature("a", now)}`,
      `Bearer ${tokens.algNone("a", now)}`,
      `Bearer ${tokens.expired("a", now)}`,
    ]) {
      seen.add((await (await call(h)).json()).reason);
    }
    assert.deepEqual([...seen].sort(), ["expired", "invalid_signature", "malformed", "missing_token"]);
  });
});
