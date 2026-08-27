import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TargetWorktreeConfig } from "../config/target-config.ts";
import {
  git,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { PostCreateFailedError, provisionWorktree } from "./provision.ts";

let tmp: string;
let checkout: string;
let worktree: string;

beforeEach(() => {
  tmp = makeTmpDir();
  checkout = makeRemoteBackedRepo(tmp).checkout;
  worktree = path.join(tmp, "wt");
  git(checkout, "worktree", "add", "-q", worktree, "-b", "feat");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function config(
  overrides: Partial<TargetWorktreeConfig> = {},
): TargetWorktreeConfig {
  return {
    copy: [],
    post_create: [],
    hook_timeout_minutes: 10,
    ...overrides,
  };
}

const inCheckout = (file: string, content: string) => {
  const target = path.join(checkout, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const read = (file: string) => readFileSync(path.join(worktree, file), "utf8");

test("a .env listed in copy lands in the worktree", async () => {
  inCheckout(".env", "SECRET=1\n");
  await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ copy: [".env"] }),
  });
  expect(read(".env")).toBe("SECRET=1\n");
});

test("a bare * pattern copies dotfiles too", async () => {
  inCheckout(".env", "SECRET=1\n");
  inCheckout("plain.txt", "hello\n");
  await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ copy: ["*"] }),
  });
  expect(read(".env")).toBe("SECRET=1\n");
  expect(read("plain.txt")).toBe("hello\n");
});

test("a directory match copies the whole tree", async () => {
  inCheckout("secrets/a.txt", "a\n");
  inCheckout("secrets/nested/b.txt", "b\n");
  await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ copy: ["secrets"] }),
  });
  expect(read("secrets/a.txt")).toBe("a\n");
  expect(read("secrets/nested/b.txt")).toBe("b\n");
});

test("an existing destination is never overwritten", async () => {
  inCheckout(".env", "FROM_CHECKOUT=1\n");
  writeFileSync(path.join(worktree, ".env"), "ALREADY_HERE=1\n");
  await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ copy: [".env"] }),
  });
  expect(read(".env")).toBe("ALREADY_HERE=1\n");
});

test(".jigs.yml self-copies into the worktree", async () => {
  inCheckout(".jigs.yml", "worktree:\n  copy: []\n");
  const result = await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config(),
  });
  expect(result.copied).toContain(".jigs.yml");
  expect(read(".jigs.yml")).toBe("worktree:\n  copy: []\n");
});

test("a pattern matching nothing is not an error", async () => {
  const result = await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ copy: ["never-exists-*"] }),
  });
  expect(result.copied).toEqual([]);
});

test("a failing post_create command rejects with the command and exit code", async () => {
  const failure = await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ post_create: ["exit 3"] }),
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect((failure as PostCreateFailedError).exitCode).toBe(3);
  expect((failure as PostCreateFailedError).command).toBe("exit 3");
});

test("commands after a failure never run", async () => {
  await expect(
    provisionWorktree({
      checkoutRoot: checkout,
      worktreePath: worktree,
      config: config({ post_create: ["exit 1", "touch after.txt"] }),
    }),
  ).rejects.toThrow(PostCreateFailedError);
  expect(existsSync(path.join(worktree, "after.txt"))).toBe(false);
});

test("post_create runs in the worktree with VIRTUAL_ENV stripped", async () => {
  vi.stubEnv("VIRTUAL_ENV", "/some/venv");
  await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({
      post_create: [
        "{ printenv VIRTUAL_ENV || true; } > venv.txt; pwd > cwd.txt",
      ],
    }),
  });
  expect(read("venv.txt")).toBe("");
  expect(read("cwd.txt").trim()).toBe(worktree);
});

test("a post_create command reading stdin sees EOF instead of hanging", async () => {
  await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({ post_create: ["cat > stdin.txt"] }),
  });
  expect(read("stdin.txt")).toBe("");
});

test("the hook timeout is a single budget across commands", async () => {
  const failure = await provisionWorktree({
    checkoutRoot: checkout,
    worktreePath: worktree,
    config: config({
      post_create: ["sleep 5", "touch never.txt"],
      hook_timeout_minutes: 0.005,
    }),
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect((failure as PostCreateFailedError).signal).toBe("SIGTERM");
  expect(existsSync(path.join(worktree, "never.txt"))).toBe(false);
});
