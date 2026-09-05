import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TargetWorktreeConfig } from "../config/target-config.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { PostCreateFailedError, provisionWorktree } from "./provision.ts";

// Provisioning is git-blind: a seed directory to copy from and a worktree to
// copy into is the whole world it sees.
let tmp: string;
let seedDir: string;
let worktree: string;

beforeEach(() => {
  tmp = makeTmpDir();
  seedDir = path.join(tmp, "seed");
  worktree = path.join(tmp, "wt");
  for (const dir of [seedDir, worktree]) mkdirSync(dir, { recursive: true });
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

const inSeed = (file: string, content: string) => {
  const target = path.join(seedDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const read = (file: string) => readFileSync(path.join(worktree, file), "utf8");

test("a .env listed in copy lands in the worktree", async () => {
  inSeed(".env", "SECRET=1\n");
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config({ copy: [".env"] }),
  });
  expect(read(".env")).toBe("SECRET=1\n");
});

test("a bare * pattern copies dotfiles too", async () => {
  inSeed(".env", "SECRET=1\n");
  inSeed("plain.txt", "hello\n");
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config({ copy: ["*"] }),
  });
  expect(read(".env")).toBe("SECRET=1\n");
  expect(read("plain.txt")).toBe("hello\n");
});

test("a directory match copies the whole tree", async () => {
  inSeed("secrets/a.txt", "a\n");
  inSeed("secrets/nested/b.txt", "b\n");
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config({ copy: ["secrets"] }),
  });
  expect(read("secrets/a.txt")).toBe("a\n");
  expect(read("secrets/nested/b.txt")).toBe("b\n");
});

test("an existing destination is never overwritten", async () => {
  inSeed(".env", "FROM_SEED=1\n");
  writeFileSync(path.join(worktree, ".env"), "ALREADY_HERE=1\n");
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config({ copy: [".env"] }),
  });
  expect(read(".env")).toBe("ALREADY_HERE=1\n");
});

test(".jigs.yml self-copies into the worktree", async () => {
  inSeed(".jigs.yml", "worktree:\n  copy: []\n");
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config(),
  });
  expect(read(".jigs.yml")).toBe("worktree:\n  copy: []\n");
});

test("a seeded .jigs.yml replaces the one the repo committed", async () => {
  // The seed is what jigs provisioned with, so it must be what the worktree
  // says it was provisioned with.
  inSeed(".jigs.yml", "worktree:\n  post_create: [npm ci]\n");
  writeFileSync(path.join(worktree, ".jigs.yml"), "worktree:\n  copy: []\n");
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config(),
  });
  expect(read(".jigs.yml")).toBe("worktree:\n  post_create: [npm ci]\n");
});

test("a pattern matching nothing is not an error", async () => {
  await expect(
    provisionWorktree({
      seedDir,
      worktreePath: worktree,
      config: config({ copy: ["never-exists-*"] }),
    }),
  ).resolves.toBeUndefined();
});

test("a failing post_create command rejects with the command and exit code", async () => {
  const failure = await provisionWorktree({
    seedDir,
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
      seedDir,
      worktreePath: worktree,
      config: config({ post_create: ["exit 1", "touch after.txt"] }),
    }),
  ).rejects.toThrow(PostCreateFailedError);
  expect(existsSync(path.join(worktree, "after.txt"))).toBe(false);
});

test("post_create runs in the worktree with VIRTUAL_ENV stripped", async () => {
  vi.stubEnv("VIRTUAL_ENV", "/some/venv");
  await provisionWorktree({
    seedDir,
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
    seedDir,
    worktreePath: worktree,
    config: config({ post_create: ["cat > stdin.txt"] }),
  });
  expect(read("stdin.txt")).toBe("");
});

test("a post_create command that backgrounds a process does not hold the request", async () => {
  const started = Date.now();
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config({ post_create: ["sh -c 'sleep 30 &'"] }),
  });
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("the hook timeout is a single budget across commands", async () => {
  const failure = await provisionWorktree({
    seedDir,
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

test("a binding with no seed directory copies nothing and still runs post_create", async () => {
  rmSync(seedDir, { recursive: true, force: true });
  await provisionWorktree({
    seedDir,
    worktreePath: worktree,
    config: config({ copy: [".env"], post_create: ["touch ran.txt"] }),
  });
  expect(existsSync(path.join(worktree, ".env"))).toBe(false);
  expect(existsSync(path.join(worktree, "ran.txt"))).toBe(true);
});
