import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { githubWebhookSecret } from "./github-webhook-secret.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("an unset or empty secret is not configured", () => {
  expect(githubWebhookSecret()).toBeUndefined();
  expect(githubWebhookSecret(factory)).toBeUndefined();
  writeFileSync(path.join(factory, ".env"), "GITHUB_WEBHOOK_SECRET=\n");
  expect(githubWebhookSecret(factory)).toBeUndefined();
});

test("the CLI reads the factory's .env and the service its loaded environment", () => {
  writeFileSync(path.join(factory, ".env"), "GITHUB_WEBHOOK_SECRET=from-file\n");
  expect(githubWebhookSecret(factory)).toBe("from-file");
  expect(githubWebhookSecret()).toBeUndefined();
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "loaded");
  expect(githubWebhookSecret()).toBe("loaded");
});
