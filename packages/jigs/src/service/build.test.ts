import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { packageRoot } from "../build/templates.ts";
import { prepare } from "./build.ts";

const GENERATED = ".jigs";

const factory = () => mkdtempSync(path.join(tmpdir(), "jigs-factory-"));

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
  expect(source).toContain('from "../jigs.config.ts"');
  expect(source).toContain("startService(factory, config)");
  // At the top level, so PORT is set before Nitro's server entry reads it.
  expect(source).toMatch(/^listenOnServicePort\(\);$/m);
});

test("preparing writes the entry, the plugin and the step files, dropping what an earlier release wrote", () => {
  const root = factory();
  mkdirSync(path.join(root, GENERATED));
  writeFileSync(path.join(root, GENERATED, "schedules.ts"), "// stale\n");
  prepare(root);

  expect(readdirSync(path.join(root, GENERATED)).sort()).toEqual([
    "routines.ts",
    "server.ts",
    "service.ts",
    "steps.ts",
  ]);
  expect(readFileSync(path.join(root, GENERATED, "steps.ts"), "utf8")).toContain('"use step"');
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

test("the factory carries the triggers the service reads", () => {
  const source = readFileSync(prepare(factory()), "utf8");
  expect(source).toContain("triggers: definition.triggers");
});

// Each exported "use step" function's name is half a durable step id, so these
// wrappers are the ids every factory's World records. e2e reads them back out
// of a real build; here the source is held to that same recorded list.
test("the step wrappers are the step ids this repo has recorded", () => {
  const wrappers = readFileSync(path.join(packageRoot(), "factory", "steps.ts"), "utf8");
  const steps = [...wrappers.matchAll(/^export async function (\w+)\(/gm)]
    .map((match) => `step//./.jigs/steps//${match[1]}`)
    .sort();
  expect(steps).toHaveLength(35);
  const recorded = readFileSync(
    path.join(packageRoot(), "e2e", "expected-ids.linear-ticket-to-pr.txt"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.startsWith("step//./.jigs/steps//"))
    .sort();
  expect(recorded).toEqual(steps);
  // One without its directive compiles clean and runs unmemoized.
  expect(wrappers.match(/"use step";/g)).toHaveLength(steps.length);
});
