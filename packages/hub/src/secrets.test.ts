import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const key = randomBytes(32);

test("decrypts what it encrypted, with a fresh IV each time", () => {
  const first = encryptSecret(key, "ghs_secret token");
  const second = encryptSecret(key, "ghs_secret token");
  expect(first).not.toBe(second);
  expect(first).not.toContain("secret");
  expect(decryptSecret(key, first)).toBe("ghs_secret token");
  expect(decryptSecret(key, second)).toBe("ghs_secret token");
});

test("rejects another key and an altered value", () => {
  const stored = encryptSecret(key, "private key");
  expect(() => decryptSecret(randomBytes(32), stored)).toThrow();
  const altered = Buffer.from(stored, "base64");
  altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1;
  expect(() => decryptSecret(key, altered.toString("base64"))).toThrow();
});
