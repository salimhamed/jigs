import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { generateFactoryIntegration } from "../cli/integration.ts";
import { GENERATED_DIR, prepare } from "./build.ts";

const factory = () => {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-factory-"));
  generateFactoryIntegration(root);
  return root;
};

test("the entry is a real file that composes the app from the factory's config", () => {
  const root = factory();
  const entry = prepare(root);

  expect(entry).toBe(path.join(root, GENERATED_DIR, "server.ts"));
  const source = readFileSync(entry, "utf8");
  // An alias would satisfy Nitro and leave the workflow builder's own
  // discovery pass with nothing to find.
  expect(source).toContain('from "@salimhamed/jigs/app"');
  expect(source).toContain('from "./factory.ts"');
});

test("the schedules plugin is generated beside the entry, holding the ticker", () => {
  const root = factory();
  prepare(root);

  const source = readFileSync(path.join(root, GENERATED_DIR, "schedules.ts"), "utf8");
  expect(source).toContain('from "@salimhamed/jigs/schedules"');
  expect(source).toContain('from "./factory.ts"');
  expect(source).toContain("startSchedules(factory)");
});

test("preparing twice restores a hand-edited entry", () => {
  const root = factory();
  const entry = prepare(root);
  const original = readFileSync(entry, "utf8");

  writeFileSync(entry, "// someone edited the generated file\n");
  prepare(root);

  expect(readFileSync(entry, "utf8")).toBe(original);
});

test("generated factory resolves deferred modules only inside the service", () => {
  const root = factory();
  prepare(root);
  const source = readFileSync(path.join(root, GENERATED_DIR, "factory.ts"), "utf8");
  expect(source).toContain('from "../jigs.config.ts"');
  expect(source).toContain("(await load()).default");
});
