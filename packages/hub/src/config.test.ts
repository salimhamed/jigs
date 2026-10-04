import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { readConfig } from "./config.ts";

const key = randomBytes(32).toString("base64");
const env = {
  HUB_PUBLIC_URL: "https://hub.example.com",
  HUB_DATABASE_URL: "postgres://hub@localhost/hub",
  HUB_ENCRYPTION_KEY: key,
};

test("reads the hub's environment", () => {
  expect(readConfig({ ...env, HOST: "0.0.0.0", PORT: "8080" })).toEqual({
    host: "0.0.0.0",
    port: 8080,
    publicUrl: new URL("https://hub.example.com"),
    databaseUrl: "postgres://hub@localhost/hub",
    encryptionKey: Buffer.from(key, "base64"),
  });
  expect(readConfig(env)).toMatchObject({ host: "127.0.0.1", port: 3000 });
});

test("names every missing or malformed value at once", () => {
  expect(() => readConfig({})).toThrow(
    [
      "The hub cannot start:",
      "  - HUB_PUBLIC_URL is not set",
      "  - HUB_DATABASE_URL is not set",
      "  - HUB_ENCRYPTION_KEY is not set",
    ].join("\n"),
  );
  expect(() =>
    readConfig({ ...env, PORT: "http", HUB_PUBLIC_URL: "hub", HUB_ENCRYPTION_KEY: "c2hvcnQ=" }),
  ).toThrow(
    [
      "The hub cannot start:",
      "  - PORT must be a port number, not http",
      "  - HUB_PUBLIC_URL must be a URL, not hub",
      "  - HUB_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)",
    ].join("\n"),
  );
});
