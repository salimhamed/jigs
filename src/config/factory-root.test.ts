import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { locateFactoryRoot } from "./factory-root.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("locates the factory root from a nested cwd", () => {
  const factory = makeFactoryRepo(tmp);
  const nested = path.join(factory, "workflows", "deep");
  mkdirSync(nested, { recursive: true });
  expect(locateFactoryRoot(nested)).toBe(factory);
});

test("errors with guidance outside a factory repo", () => {
  expect(() => locateFactoryRoot(tmp)).toThrow("not inside a factory repo");
});
