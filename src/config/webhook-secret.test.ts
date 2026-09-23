import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { webhookSecret } from "./webhook-secret.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("an unset or empty secret is not configured", () => {
  expect(webhookSecret("github")).toBeUndefined();
  expect(webhookSecret("github", factory)).toBeUndefined();
  writeFileSync(path.join(factory, ".env"), "GITHUB_WEBHOOK_SECRET=\n");
  expect(webhookSecret("github", factory)).toBeUndefined();
});

test("the CLI reads the factory's .env and the service its loaded environment", () => {
  writeFileSync(path.join(factory, ".env"), "GITHUB_WEBHOOK_SECRET=from-file\n");
  expect(webhookSecret("github", factory)).toBe("from-file");
  expect(webhookSecret("github")).toBeUndefined();
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "loaded");
  expect(webhookSecret("github")).toBe("loaded");
});

test("each provider reads its own variable", () => {
  writeFileSync(path.join(factory, ".env"), "LINEAR_WEBHOOK_SECRET=linear-file\n");
  expect(webhookSecret("linear", factory)).toBe("linear-file");
  expect(webhookSecret("github", factory)).toBeUndefined();
});
