import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { prepare } from "./build.ts";
import { GENERATED_DIR } from "./nitro.ts";

const factory = () => mkdtempSync(path.join(tmpdir(), "jigs-factory-"));

test("the entry is a real file that composes the app from the factory's config", () => {
  const root = factory();
  const entry = prepare(root);

  expect(entry).toBe(path.join(root, GENERATED_DIR, "server.ts"));
  const source = readFileSync(entry, "utf8");
  // An alias would satisfy Nitro and leave the workflow builder's own
  // discovery pass with nothing to find.
  expect(source).toContain('from "@jigs/service/app"');
  expect(source).toContain('from "../jigs.config.ts"');
});

test("preparing twice restores a hand-edited entry", () => {
  const root = factory();
  const entry = prepare(root);
  const original = readFileSync(entry, "utf8");

  writeFileSync(entry, "// someone edited the generated file\n");
  prepare(root);

  expect(readFileSync(entry, "utf8")).toBe(original);
});
