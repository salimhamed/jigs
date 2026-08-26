import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  detectCopyFiles,
  generateTargetConfig,
  inferPostCreate,
} from "./target-scaffold.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

function touch(...files: string[]): void {
  for (const file of files) writeFileSync(path.join(tmp, file), "");
}

test.each([
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
  ["uv.lock", "uv sync --frozen"],
  ["poetry.lock", "poetry install"],
  ["Gemfile.lock", "bundle install"],
])("%s infers %s", (lockfile, command) => {
  touch(lockfile);
  expect(inferPostCreate(tmp)).toEqual([command]);
});

test("first match wins within a package-manager group", () => {
  touch("pnpm-lock.yaml", "package-lock.json");
  expect(inferPostCreate(tmp)).toEqual(["pnpm install --frozen-lockfile"]);
});

test("polyglot repos get one command per group", () => {
  touch("pnpm-lock.yaml", "uv.lock");
  expect(inferPostCreate(tmp)).toEqual([
    "pnpm install --frozen-lockfile",
    "uv sync --frozen",
  ]);
});

test("mise is prepended and pre-commit appended", () => {
  touch(".mise.toml", "pnpm-lock.yaml", ".pre-commit-config.yaml");
  expect(inferPostCreate(tmp)).toEqual([
    "mise install",
    "pnpm install --frozen-lockfile",
    "pre-commit install",
  ]);
});

test("no lockfiles infers nothing", () => {
  expect(inferPostCreate(tmp)).toEqual([]);
});

test("detectCopyFiles finds .env files, excluding examples", () => {
  touch(".env", ".env.local", ".env.example", ".env.sample", "README.md");
  expect(detectCopyFiles(tmp)).toEqual([".env", ".env.local"]);
});

test("generateTargetConfig renders the worktree section with a header comment", () => {
  const text = generateTargetConfig(
    [".env"],
    ["pnpm install --frozen-lockfile"],
  );
  expect(text).toContain("Scaffolded by `jigs bind`");
  expect(text).toContain("worktree:");
  expect(text).toContain("- .env");
  expect(text).toContain("- pnpm install --frozen-lockfile");
});

test("generateTargetConfig renders an empty copy list with an example comment", () => {
  const text = generateTargetConfig([], []);
  expect(text).toContain("copy: []");
  expect(text).toContain("e.g. .env");
});
