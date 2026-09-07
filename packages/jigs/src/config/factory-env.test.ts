import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { factoryEnvValue, readFactoryEnv } from "./factory-env.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  // Otherwise the shell-wins branch reads whatever the developer exports.
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("LINEAR_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const writeEnv = (text: string) =>
  writeFileSync(path.join(factory, ".env"), text);

test("a factory with no .env reads as an empty environment", () => {
  expect(readFactoryEnv(factory)).toEqual({});
  expect(factoryEnvValue(factory, "GITHUB_TOKEN")).toBeUndefined();
});

test("declared values are read, and an empty slot counts as unset", () => {
  writeEnv("GITHUB_TOKEN=ghp_declared\nLINEAR_API_KEY=\n");
  expect(readFactoryEnv(factory)).toEqual({
    GITHUB_TOKEN: "ghp_declared",
    LINEAR_API_KEY: "",
  });
  expect(factoryEnvValue(factory, "GITHUB_TOKEN")).toBe("ghp_declared");
  expect(factoryEnvValue(factory, "LINEAR_API_KEY")).toBeUndefined();
});

test("an exported value wins over the file, and an empty export does not", () => {
  writeEnv("GITHUB_TOKEN=ghp_declared\n");
  vi.stubEnv("GITHUB_TOKEN", "ghp_exported");
  expect(factoryEnvValue(factory, "GITHUB_TOKEN")).toBe("ghp_exported");
  vi.stubEnv("GITHUB_TOKEN", "");
  expect(factoryEnvValue(factory, "GITHUB_TOKEN")).toBe("ghp_declared");
});
