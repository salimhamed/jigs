import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Binding } from "../../config/factory-config.ts";
import { JigsError } from "../../errors.ts";
import { CopySourceMissingError, PostCreateFailedError, provisionWorktree } from "./provision.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

// The binding's own directory in the factory repo to copy from and a worktree
// to copy into is the whole world provisioning sees; the binding is what tells
// it what to do.
let tmp: string;
let factoryRoot: string;
let worktree: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factoryRoot = path.join(tmp, "factory");
  worktree = path.join(tmp, "wt");
  for (const dir of [factoryRoot, worktree]) {
    mkdirSync(dir, { recursive: true });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function binding(overrides: Partial<Binding> = {}): Binding {
  return {
    name: "api",
    remote: "git@github.com:acme/api.git",
    mergeMethod: "squash",
    copy: [],
    postCreate: [],
    hookTimeoutMinutes: 10,
    ...overrides,
  };
}

const provision = (overrides: Partial<Binding> = {}) =>
  provisionWorktree({
    binding: binding(overrides),
    factoryRoot,
    worktreePath: worktree,
  });

// Every copy source lives under the binding's own bindings/<name>/.
const inCopyDir = (file: string, content: string) => {
  const target = path.join(factoryRoot, "bindings", "api", file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const read = (file: string) => readFileSync(path.join(worktree, file), "utf8");

test("a .env listed in copy lands in the worktree", async () => {
  inCopyDir(".env", "SECRET=1\n");
  await provision({ copy: [".env"] });
  expect(read(".env")).toBe("SECRET=1\n");
});

test("a nested entry lands at that same path inside the worktree", async () => {
  inCopyDir("config/app.local", "local=1\n");
  await provision({ copy: ["config/app.local"] });
  expect(read("config/app.local")).toBe("local=1\n");
});

test("a bare * pattern copies dotfiles too", async () => {
  inCopyDir(".env", "SECRET=1\n");
  inCopyDir("plain.txt", "hello\n");
  await provision({ copy: ["*"] });
  expect(read(".env")).toBe("SECRET=1\n");
  expect(read("plain.txt")).toBe("hello\n");
});

test("a directory match copies the whole tree", async () => {
  inCopyDir("secrets/a.txt", "a\n");
  inCopyDir("secrets/nested/b.txt", "b\n");
  await provision({ copy: ["secrets"] });
  expect(read("secrets/a.txt")).toBe("a\n");
  expect(read("secrets/nested/b.txt")).toBe("b\n");
});

test("an existing destination is never overwritten", async () => {
  inCopyDir(".env", "FROM_FACTORY=1\n");
  writeFileSync(path.join(worktree, ".env"), "ALREADY_HERE=1\n");
  await provision({ copy: [".env"] });
  expect(read(".env")).toBe("ALREADY_HERE=1\n");
});

test("a copy entry that matches nothing fails, naming the binding and the directory", async () => {
  const failure = await provision({ copy: [".env"] }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(CopySourceMissingError);
  expect((failure as CopySourceMissingError).message).toBe(
    "binding api: copy entry .env matches nothing under bindings/api/",
  );
});

test("an entry climbing out of the binding's directory is refused", async () => {
  const outside = path.join(factoryRoot, "elsewhere");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, ".env"), "STOLEN=1\n");
  const failure = await provision({ copy: ["../elsewhere/.env"] }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(JigsError);
  expect((failure as JigsError).message).toBe(
    "binding api: copy entry ../elsewhere/.env must be a relative path inside bindings/api/",
  );
  expect(existsSync(path.join(worktree, ".env"))).toBe(false);
});

test("an absolute entry is refused rather than silently matching nothing", async () => {
  const failure = await provision({ copy: ["/etc/hostname"] }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(JigsError);
  expect((failure as JigsError).message).toBe(
    "binding api: copy entry /etc/hostname must be a relative path inside bindings/api/",
  );
});

test("a missing copy entry fails before any postCreate runs", async () => {
  await expect(provision({ copy: [".env"], postCreate: ["touch ran.txt"] })).rejects.toThrow(
    CopySourceMissingError,
  );
  expect(existsSync(path.join(worktree, "ran.txt"))).toBe(false);
});

test("a failing postCreate command rejects with the command and exit code", async () => {
  const failure = await provision({ postCreate: ["exit 3"] }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect((failure as PostCreateFailedError).exitCode).toBe(3);
  expect((failure as PostCreateFailedError).command).toBe("exit 3");
});

test("commands after a failure never run", async () => {
  await expect(provision({ postCreate: ["exit 1", "touch after.txt"] })).rejects.toThrow(
    PostCreateFailedError,
  );
  expect(existsSync(path.join(worktree, "after.txt"))).toBe(false);
});

test("postCreate runs in the worktree with VIRTUAL_ENV stripped", async () => {
  vi.stubEnv("VIRTUAL_ENV", "/some/venv");
  await provision({
    postCreate: ["{ printenv VIRTUAL_ENV || true; } > venv.txt; pwd > cwd.txt"],
  });
  expect(read("venv.txt")).toBe("");
  expect(read("cwd.txt").trim()).toBe(worktree);
});

test("a postCreate command reading stdin sees EOF instead of hanging", async () => {
  await provision({ postCreate: ["cat > stdin.txt"] });
  expect(read("stdin.txt")).toBe("");
});

test("a postCreate command that backgrounds a process does not hold the request", async () => {
  const started = Date.now();
  await provision({ postCreate: ["sh -c 'sleep 30 &'"] });
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("the hook timeout is a single budget across commands", async () => {
  const failure = await provision({
    postCreate: ["sleep 5", "touch never.txt"],
    hookTimeoutMinutes: 0.005,
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect((failure as PostCreateFailedError).signal).toBe("SIGTERM");
  expect(existsSync(path.join(worktree, "never.txt"))).toBe(false);
});

test("a binding declaring neither copy nor postCreate provisions nothing", async () => {
  await expect(provision()).resolves.toBeUndefined();
  expect(existsSync(path.join(worktree, ".env"))).toBe(false);
});
