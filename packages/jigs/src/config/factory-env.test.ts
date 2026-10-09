import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { resolveFactoryContext } from "./factory-context.ts";
import { readFactoryEnv } from "./factory-env.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  // Otherwise the shell-wins branch reads whatever the developer exports.
  vi.stubEnv("JIGS_HUB_TOKEN", "");
  vi.stubEnv("LINEAR_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const writeEnv = (text: string) => writeFileSync(path.join(factory, ".env"), text);

test("a factory with no .env reads as an empty environment", () => {
  expect(readFactoryEnv(factory)).toEqual({});
  expect(resolveFactoryContext(factory).env("JIGS_HUB_TOKEN")).toBeUndefined();
});

test("declared values are read, and an empty slot counts as unset", () => {
  writeEnv("JIGS_HUB_TOKEN=declared\nLINEAR_API_KEY=\n");
  expect(readFactoryEnv(factory)).toEqual({
    JIGS_HUB_TOKEN: "declared",
    LINEAR_API_KEY: "",
  });
  expect(resolveFactoryContext(factory).env("JIGS_HUB_TOKEN")).toBe("declared");
  expect(resolveFactoryContext(factory).env("LINEAR_API_KEY")).toBeUndefined();
});

test("an exported value wins over the file, and an empty export does not", () => {
  writeEnv("JIGS_HUB_TOKEN=declared\n");
  vi.stubEnv("JIGS_HUB_TOKEN", "exported");
  expect(resolveFactoryContext(factory).env("JIGS_HUB_TOKEN")).toBe("exported");
  vi.stubEnv("JIGS_HUB_TOKEN", "");
  expect(resolveFactoryContext(factory).env("JIGS_HUB_TOKEN")).toBe("declared");
});
