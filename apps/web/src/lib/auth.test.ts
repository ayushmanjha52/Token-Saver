import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, hashPassword, sameOrigin, validateSignUp, verifyPassword } from "./auth.js";

test("passwords hash with a fresh salt and verify only with the right password", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b, "salted");
  assert.ok(a.startsWith("scrypt$32768$8$1$") && !a.includes("correct"));
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("sign-up input is trimmed, lower-cased and validated", () => {
  const v = validateSignUp({ name: "  Ada ", email: " Ada@Example.COM ", organization: " Acme ", password: "long enough pw" });
  assert.deepEqual(v, { name: "Ada", email: "ada@example.com", organization: "Acme", password: "long enough pw" });
  for (const bad of [
    { name: "", email: "a@b.co", organization: "x", password: "0123456789" },
    { name: "a", email: "not-an-email", organization: "x", password: "0123456789" },
    { name: "a", email: "a@b.co", organization: "", password: "0123456789" },
    { name: "a", email: "a@b.co", organization: "x", password: "short" },
  ]) {
    assert.throws(() => validateSignUp(bad), (e: unknown) => e instanceof AuthError && e.code === "invalid_input");
  }
});

test("cross-site posts are refused; same-site and origin-less ones pass", () => {
  const req = (origin?: string) => new Request("https://tokengrid.example/api/auth/signin", { method: "POST", headers: origin ? { origin } : {} });
  assert.equal(sameOrigin(req("https://tokengrid.example")), true);
  assert.equal(sameOrigin(req()), true);
  assert.equal(sameOrigin(req("https://evil.example")), false);
});
