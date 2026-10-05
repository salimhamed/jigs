import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { type FactoryContext, resolveFactoryContext } from "./factory-context.ts";
import { webhookSecret } from "./webhook-secret.ts";

let tmp: string;
let factory: string;
let ctx: FactoryContext;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  ctx = resolveFactoryContext(factory);
  vi.stubEnv("PAGERDUTY_WEBHOOK_SECRET", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("an unset or empty secret is not configured", () => {
  expect(webhookSecret("pagerduty", ctx)).toBeUndefined();
  writeFileSync(path.join(factory, ".env"), "PAGERDUTY_WEBHOOK_SECRET=\n");
  expect(webhookSecret("pagerduty", ctx)).toBeUndefined();
});

test("the factory's .env is read, and the environment wins over it", () => {
  writeFileSync(path.join(factory, ".env"), "PAGERDUTY_WEBHOOK_SECRET=from-file\n");
  expect(webhookSecret("pagerduty", ctx)).toBe("from-file");
  vi.stubEnv("PAGERDUTY_WEBHOOK_SECRET", "loaded");
  expect(webhookSecret("pagerduty", ctx)).toBe("loaded");
});
