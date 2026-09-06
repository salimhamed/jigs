import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Binding, CliError } from "@salimhamed/jigs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CopySourceMissingError,
  PostCreateFailedError,
  provisionWorktree,
} from "./provision";
import { makeTmpDir, removeTmpDir } from "./test-fixtures";

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
    copy: [],
    post_create: [],
    hook_timeout_minutes: 10,
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
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toBe(
    "binding api: copy entry ../elsewhere/.env must be a relative path inside bindings/api/",
  );
  expect(existsSync(path.join(worktree, ".env"))).toBe(false);
});

test("an absolute entry is refused rather than silently matching nothing", async () => {
  const failure = await provision({ copy: ["/etc/hostname"] }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toBe(
    "binding api: copy entry /etc/hostname must be a relative path inside bindings/api/",
  );
});

test("a missing copy entry fails before any post_create runs", async () => {
  await expect(
    provision({ copy: [".env"], post_create: ["touch ran.txt"] }),
  ).rejects.toThrow(CopySourceMissingError);
  expect(existsSync(path.join(worktree, "ran.txt"))).toBe(false);
});

test("a failing post_create command rejects with the command and exit code", async () => {
  const failure = await provision({ post_create: ["exit 3"] }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect((failure as PostCreateFailedError).exitCode).toBe(3);
  expect((failure as PostCreateFailedError).command).toBe("exit 3");
});

test("commands after a failure never run", async () => {
  await expect(
    provision({ post_create: ["exit 1", "touch after.txt"] }),
  ).rejects.toThrow(PostCreateFailedError);
  expect(existsSync(path.join(worktree, "after.txt"))).toBe(false);
});

test("post_create runs in the worktree with VIRTUAL_ENV stripped", async () => {
  vi.stubEnv("VIRTUAL_ENV", "/some/venv");
  await provision({
    post_create: [
      "{ printenv VIRTUAL_ENV || true; } > venv.txt; pwd > cwd.txt",
    ],
  });
  expect(read("venv.txt")).toBe("");
  expect(read("cwd.txt").trim()).toBe(worktree);
});

test("a post_create command reading stdin sees EOF instead of hanging", async () => {
  await provision({ post_create: ["cat > stdin.txt"] });
  expect(read("stdin.txt")).toBe("");
});

test("a post_create command that backgrounds a process does not hold the request", async () => {
  const started = Date.now();
  await provision({ post_create: ["sh -c 'sleep 30 &'"] });
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("the hook timeout is a single budget across commands", async () => {
  const failure = await provision({
    post_create: ["sleep 5", "touch never.txt"],
    hook_timeout_minutes: 0.005,
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect((failure as PostCreateFailedError).signal).toBe("SIGTERM");
  expect(existsSync(path.join(worktree, "never.txt"))).toBe(false);
});

test("a binding declaring neither copy nor post_create provisions nothing", async () => {
  await expect(provision()).resolves.toBeUndefined();
  expect(existsSync(path.join(worktree, ".env"))).toBe(false);
});
