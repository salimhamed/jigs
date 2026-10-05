import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { decryptJson, encryptJson } from "./secrets.ts";

const key = randomBytes(32);

test("decrypts what it encrypted, with a fresh IV each time", () => {
  const value = { token: "ghs_secret token" };
  const first = encryptJson(key, value);
  const second = encryptJson(key, value);
  expect(first).not.toBe(second);
  expect(first).not.toContain("secret");
  expect(decryptJson(key, first)).toEqual(value);
  expect(decryptJson(key, second)).toEqual(value);
});

test("rejects another key and an altered value", () => {
  const stored = encryptJson(key, { privateKey: "private key" });
  expect(() => decryptJson(randomBytes(32), stored)).toThrow();
  const altered = Buffer.from(stored, "base64");
  altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1;
  expect(() => decryptJson(key, altered.toString("base64"))).toThrow();
});
