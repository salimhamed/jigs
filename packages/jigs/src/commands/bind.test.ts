import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  git,
  makeFactoryRepo,
  makeTargetRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { type BindDeps, bindRepo } from "./bind.ts";

let tmp: string;
let factory: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  lines = [];
});
afterEach(() => {
  removeTmpDir(tmp);
});

function deps(overrides: Partial<BindDeps> = {}): BindDeps {
  return {
    cwd: factory,
    home: tmp,
    out: (line) => lines.push(line),
    ...overrides,
  };
}

const jigsYml = () => readFileSync(path.join(factory, "jigs.yml"), "utf8");

test("zero-config bind writes a ~-contracted binding with the pinned remote", async () => {
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/target-repo.git",
  });
  const result = await bindRepo(target, deps());
  expect(result).toMatchObject({
    name: "target-repo",
    path: "~/target-repo",
    remote: "git@github.com:acme/target-repo.git",
    scaffolded: false,
  });
  expect(jigsYml()).toContain("target-repo:");
  expect(jigsYml()).toContain("path: ~/target-repo");
  expect(jigsYml()).toContain("remote: git@github.com:acme/target-repo.git");
});

test("re-bind is idempotent: no duplicate entries, comments preserved, bytes unchanged", async () => {
  const target = makeTargetRepo(tmp);
  await bindRepo(target, deps());
  const withComment = `# keep me\n${jigsYml()}`;
  writeFileSync(path.join(factory, "jigs.yml"), withComment);

  await bindRepo(target, deps());
  expect(jigsYml()).toBe(withComment);
});

test("re-bind after a remote change re-pins with a notice", async () => {
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/old.git",
  });
  await bindRepo(target, deps());
  git(target, "remote", "set-url", "origin", "git@github.com:acme/new.git");

  await bindRepo(target, deps());
  expect(jigsYml()).toContain("git@github.com:acme/new.git");
  expect(jigsYml()).not.toContain("git@github.com:acme/old.git");
  expect(lines.some((l) => l.includes("remote pin updated"))).toBe(true);
});

test("--name overrides the derived name", async () => {
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps(), { name: "api" });
  expect(result.name).toBe("api");
  expect(jigsYml()).toContain("api:");
});

test("name collision with a different path errors with a --name hint", async () => {
  const first = makeTargetRepo(tmp, { name: "group-a/repo" });
  const second = makeTargetRepo(tmp, { name: "group-b/repo" });
  await bindRepo(first, deps());
  await expect(bindRepo(second, deps())).rejects.toThrow("already bound to");
});

test("invalid binding name errors", async () => {
  const target = makeTargetRepo(tmp);
  await expect(bindRepo(target, deps(), { name: "bad name!" })).rejects.toThrow(
    "invalid binding name",
  );
});

test("an invalid target never touches jigs.yml", async () => {
  const before = jigsYml();
  await expect(bindRepo(path.join(tmp, "missing"), deps())).rejects.toThrow(
    "not a directory",
  );
  await expect(bindRepo(tmp, deps())).rejects.toThrow("not a git checkout");
  expect(jigsYml()).toBe(before);
});

test("bind outside a factory repo fails with guidance", async () => {
  const target = makeTargetRepo(tmp);
  await expect(bindRepo(target, deps({ cwd: tmp }))).rejects.toThrow(
    "not inside a factory repo",
  );
});

test("scaffold offer writes .jigs.yml only on confirm", async () => {
  const target = makeTargetRepo(tmp, {
    files: { "pnpm-lock.yaml": "", ".env": "SECRET=1" },
  });
  const result = await bindRepo(target, deps({ confirm: async () => true }));
  expect(result.scaffolded).toBe(true);
  const scaffold = readFileSync(path.join(target, ".jigs.yml"), "utf8");
  expect(scaffold).toContain("- .env");
  expect(scaffold).toContain("- pnpm install --frozen-lockfile");
});

test("declining the scaffold writes nothing but keeps the bind", async () => {
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps({ confirm: async () => false }));
  expect(result.scaffolded).toBe(false);
  expect(existsSync(path.join(target, ".jigs.yml"))).toBe(false);
  expect(jigsYml()).toContain("target-repo:");
});

test("scaffold never overwrites an existing .jigs.yml", async () => {
  const target = makeTargetRepo(tmp, {
    files: { ".jigs.yml": "worktree: {}\n" },
  });
  let asked = false;
  await bindRepo(
    target,
    deps({
      confirm: async () => {
        asked = true;
        return true;
      },
    }),
  );
  expect(asked).toBe(false);
  expect(readFileSync(path.join(target, ".jigs.yml"), "utf8")).toBe(
    "worktree: {}\n",
  );
});

test("non-interactive bind skips the scaffold offer with a note", async () => {
  const target = makeTargetRepo(tmp);
  const result = await bindRepo(target, deps());
  expect(result.scaffolded).toBe(false);
  expect(lines.some((l) => l.includes("non-interactive"))).toBe(true);
});
