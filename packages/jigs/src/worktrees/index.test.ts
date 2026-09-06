import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Binding } from "../config/factory-config.ts";
import type { createWorktree, worktreeStatus } from "./create.ts";
import type { WorktreeFacts } from "./facts.ts";
import {
  type ProvisionRunWorktreeDeps,
  provisionRunWorktree,
  teardownRunWorktrees,
} from "./index.ts";
import { bindingRepoDir, worktreePath } from "./layout.ts";
import {
  PostCreateFailedError,
  type ProvisionWorktreeOptions,
} from "./provision.ts";
import type { WorktreeRow } from "./registry.ts";
import { WorktreeOwnedError } from "./reuse.ts";
import { makeFakeSql } from "./test-fixtures.ts";

let tmp: string;
let repoDir: string;
let target: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-worktrees-test-"));
  store = new Map();
  vi.stubEnv("JIGS_FACTORY_ROOT", tmp);
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeFileSync(path.join(tmp, "jigs.yml"), "bindings: {}\n");
  const dirs = { factoryRoot: tmp, bindingName: "api" };
  repoDir = bindingRepoDir(dirs);
  target = worktreePath({ ...dirs, branch: "feat" });
  markClone();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

// The service clones every binding at start, so the request path finds one
// already there — the marker is what says so.
function markClone(): void {
  const dir = path.join(repoDir, "refs", "remotes", "origin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "HEAD"), "ref: refs/remotes/origin/main\n");
}

const binding: Binding = {
  name: "api",
  remote: "git@github.com:acme/api.git",
  copy: [".env"],
  post_create: ["npm ci"],
  hook_timeout_minutes: 20,
};

const request = { binding: "api", branch: "feat" };

type CutOptions = Parameters<typeof createWorktree>[0];
type WorktreeStatus = NonNullable<Awaited<ReturnType<typeof worktreeStatus>>>;

const cleanDisk: WorktreeStatus = {
  branchMatches: true,
  clean: true,
  diverged: false,
  defaultBranch: "main",
  baseSha: "base1",
};

function registeredRow(ownerRunId: string): WorktreeRow {
  return {
    path: target,
    branch: "feat",
    ownerRunId,
    state: "active",
    repoDir,
  };
}

const cutFacts = (options: CutOptions): WorktreeFacts => ({
  path: options.worktreePath,
  branch: options.branch,
  defaultBranch: "main",
  baseSha: "base2",
});

// The registry write stays real (through the fake sql); the git half and the
// binding's provisioning are stood in for, so these tests are about what
// happens around them.
const deps = (
  overrides: ProvisionRunWorktreeDeps = {},
): ProvisionRunWorktreeDeps => ({
  sql: makeFakeSql(store),
  resolveBinding: () => binding,
  runIsLive: async () => false,
  worktreeStatus: async () => null,
  createWorktree: async (options) => cutFacts(options),
  provision: async () => {},
  log: () => {},
  ...overrides,
});

test("a worktree registered to a live run is refused, naming the owner", async () => {
  store.set(target, registeredRow("run_owner"));
  const failure = await provisionRunWorktree(
    request,
    "run_new",
    deps({
      runIsLive: async () => true,
      worktreeStatus: async () => cleanDisk,
    }),
  ).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(WorktreeOwnedError);
  expect((failure as WorktreeOwnedError).owningRunId).toBe("run_owner");
  // The escape hatch the message names has to keep existing.
  expect((failure as WorktreeOwnedError).message).toContain(
    "jigs cancel run_owner",
  );
  expect(store.get(target)?.ownerRunId).toBe("run_owner");
});

test("a live foreign owner is refused before disk is ever inspected", async () => {
  store.set(target, registeredRow("run_owner"));
  await expect(
    provisionRunWorktree(
      request,
      "run_new",
      deps({
        runIsLive: async () => true,
        worktreeStatus: async () => {
          throw new Error("worktreeStatus must not run for an owned worktree");
        },
      }),
    ),
  ).rejects.toThrow(WorktreeOwnedError);
});

test("a terminal owner's clean worktree is reused and re-owned", async () => {
  store.set(target, registeredRow("run_done"));
  const facts = await provisionRunWorktree(
    request,
    "run_new",
    deps({ worktreeStatus: async () => cleanDisk }),
  );
  expect(facts.baseSha).toBe("base1");
  expect(store.get(target)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
  });
});

test("a registry row whose directory is gone is cut afresh and re-owned", async () => {
  store.set(target, registeredRow("run_done"));
  const facts = await provisionRunWorktree(request, "run_new", deps());
  expect(facts).toEqual(
    cutFacts({ repoDir, worktreePath: target, branch: "feat" }),
  );
  expect(store.get(target)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
  });
});

test("the owning run re-enters its own dirty worktree without asking whether it is live", async () => {
  store.set(target, registeredRow("run_owner"));
  const facts = await provisionRunWorktree(
    request,
    "run_owner",
    deps({
      runIsLive: async () => {
        throw new Error("the owner's own liveness is beside the point");
      },
      worktreeStatus: async () => ({ ...cleanDisk, clean: false }),
    }),
  );
  expect(facts.baseSha).toBe(cleanDisk.baseSha);
  expect(store.get(target)?.ownerRunId).toBe("run_owner");
});

test("no worktree on disk creates one and registers the requesting run", async () => {
  const createCalls: CutOptions[] = [];
  const facts = await provisionRunWorktree(
    request,
    "run_new",
    deps({
      createWorktree: async (options) => {
        createCalls.push(options);
        return cutFacts(options);
      },
    }),
  );
  expect(facts).toEqual(
    cutFacts({ repoDir, worktreePath: target, branch: "feat" }),
  );
  expect(createCalls).toEqual([
    { repoDir, worktreePath: target, branch: request.branch },
  ]);
  expect(store.get(target)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
  });
});

test("a failing post_create leaves the row marked provision-failed and rethrows", async () => {
  const failure = await provisionRunWorktree(
    request,
    "run_a",
    deps({
      provision: async () => {
        throw new PostCreateFailedError("exit 3", 3, null, "boom");
      },
    }),
  ).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect(store.get(target)?.state).toBe("provision-failed");
});

test("a successful request registers the worktree as active against the clone", async () => {
  await provisionRunWorktree(request, "run_a", deps());
  expect(store.get(target)).toMatchObject({
    state: "active",
    ownerRunId: "run_a",
    repoDir,
  });
});

test("a binding with no clone is refused, naming the restart that makes one", async () => {
  rmSync(repoDir, { recursive: true, force: true });
  const failure = await provisionRunWorktree(request, "run_a", deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain(`binding api has no clone at ${repoDir}`);
  expect((failure as { hint?: string }).hint).toContain("jigs service restart");
  expect(store.size).toBe(0);
});

test("the binding's own provisioning is what the worktree is provisioned with", async () => {
  const calls: ProvisionWorktreeOptions[] = [];
  await provisionRunWorktree(
    request,
    "run_a",
    deps({
      provision: async (options: ProvisionWorktreeOptions) => {
        calls.push(options);
      },
    }),
  );
  expect(calls).toEqual([{ binding, factoryRoot: tmp, worktreePath: target }]);
});

test("a provisioned worktree logs its binding, branch, and path", async () => {
  const lines: string[] = [];
  await provisionRunWorktree(
    request,
    "run_a",
    deps({ log: (line: string) => lines.push(line) }),
  );
  expect(lines).toContain(
    `[worktree] provisioned binding=api branch=feat path=${target}`,
  );
});

test("the teardownRunWorktrees alias refuses an unmerged outcome instead of deleting branches", () => {
  expect(() => teardownRunWorktrees("run_1", { merged: false })).toThrow(
    /only tears down merged runs/,
  );
});
