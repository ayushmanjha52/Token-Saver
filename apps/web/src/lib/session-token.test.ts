import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession } from "./session-token.js";

const secret = "x".repeat(40);
const s = { userId: "u1", orgId: "o1" };

test("round-trips", () => {
  assert.deepEqual(verifySession(signSession(s, secret), secret), s);
});

test("rejects tampering, a different secret, expiry and garbage", () => {
  const t = signSession(s, secret);
  const [payload, mac] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "admin", o: "o1", exp: 9e9 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${mac}`, secret), null);
  assert.equal(verifySession(`${payload}.${mac}x`, secret), null);
  assert.equal(verifySession(t, "y".repeat(40)), null);
  assert.equal(verifySession(t, secret, Date.now() + 13 * 3600_000), null);
  for (const g of [undefined, "", ".", "abc", "a.b.c"]) assert.equal(verifySession(g, secret), null);
});
