import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { generateFactoryIntegration } from "../build/integration.ts";
import { prepare } from "./build.ts";

const GENERATED = ".jigs";

const factory = () => {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-factory-"));
  generateFactoryIntegration(root);
  return root;
};

test("the entry is a real file that composes the app from the factory's config", () => {
  const root = factory();
  const entry = prepare(root);

  expect(entry).toBe(path.join(root, GENERATED, "server.ts"));
  const source = readFileSync(entry, "utf8");
  // An alias would satisfy Nitro and leave the workflow builder's own
  // discovery pass with nothing to find.
  expect(source).toContain('from "@jigs-ai/jigs/service"');
  expect(source).toContain("createApp(factory)");
});

test("the service plugin is generated beside the entry and starts the factory's service", () => {
  const root = factory();
  prepare(root);

  const source = readFileSync(path.join(root, GENERATED, "service.ts"), "utf8");
  expect(source).toContain('from "@jigs-ai/jigs/service"');
  expect(source).toContain('from "./server.ts"');
  expect(source).toContain("startService(factory)");
});

test("preparing writes only the entry and the plugin, dropping what an earlier release wrote", () => {
  const root = factory();
  mkdirSync(path.join(root, GENERATED));
  writeFileSync(path.join(root, GENERATED, "schedules.ts"), "// stale\n");
  prepare(root);

  expect(existsSync(path.join(root, GENERATED, "schedules.ts"))).toBe(false);
  expect(existsSync(path.join(root, GENERATED, "server.ts"))).toBe(true);
  expect(existsSync(path.join(root, GENERATED, "service.ts"))).toBe(true);
});

test("preparing twice restores a hand-edited entry", () => {
  const root = factory();
  const entry = prepare(root);
  const original = readFileSync(entry, "utf8");

  writeFileSync(entry, "// someone edited the generated file\n");
  prepare(root);

  expect(readFileSync(entry, "utf8")).toBe(original);
});

test("the entry resolves deferred modules only inside the service", () => {
  const source = readFileSync(prepare(factory()), "utf8");
  expect(source).toContain('from "../jigs.config.ts"');
  expect(source).toContain("(await load()).default");
});

test("the factory carries the triggers and webhook settings the service reads", () => {
  const source = readFileSync(prepare(factory()), "utf8");
  expect(source).toContain("triggers: definition.triggers");
  expect(source).toContain("webhooks: definition.webhooks");
});
