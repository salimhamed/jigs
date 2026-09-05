import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Binding,
  bindingRepoDir,
  PostCreateFailedError,
  type ProvisionWorktreeOptions,
  worktreePath,
} from "jigs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type AcquireWorktreeDeps,
  type AcquireWorktreeRequest,
  acquireWorktree,
} from "./acquire";
import type { WorktreeRow } from "./registry";
import { provisionRequest, WorktreeRegistryUnavailableError } from "./request";
import { makeFakeSql } from "./test-fixtures";

let tmp: string;
let repoDir: string;
let target: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-request-test-"));
  store = new Map();
  // An ambient dev-database URL would otherwise make this lane open a real
  // connection and read the operator's registry.
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  vi.stubEnv("JIGS_FACTORY_ROOT", tmp);
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  writeFileSync(path.join(tmp, "jigs.yml"), "bindings: {}\n");
  const dirs = { factoryRoot: tmp, bindingName: "api" };
  repoDir = bindingRepoDir(dirs);
  target = worktreePath({ ...dirs, branch: "feat" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const binding: Binding = {
  name: "api",
  remote: "git@github.com:acme/api.git",
  copy: [".env"],
  post_create: ["npm ci"],
  hook_timeout_minutes: 20,
};

// The acquire seam keeps the registry write real (through the fake sql) while
// standing in for the git half; these tests are about what happens around it.
const deps = (overrides: Record<string, unknown> = {}) => ({
  sql: makeFakeSql(store),
  resolveBinding: () => binding,
  ensureClone: async () => {},
  acquire: (
    request: AcquireWorktreeRequest,
    acquireDeps: AcquireWorktreeDeps,
  ) =>
    acquireWorktree(request, {
      ...acquireDeps,
      runIsLive: async () => false,
      worktreeStatus: async () => null,
      createWorktree: async (options) => ({
        path: options.worktreePath,
        branch: options.branch,
        resolution: "new" as const,
        defaultBranch: "main",
        baseSha: "base1",
        headSha: "base1",
        behindDefault: 0,
      }),
    }),
  log: () => {},
  ...overrides,
});

test("a failing post_create leaves the row marked provision-failed and rethrows", async () => {
  const failure = await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat" },
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
  await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat", keep: true },
    deps({ provision: async () => {} }),
  );
  expect(store.get(target)).toMatchObject({
    state: "active",
    ownerRunId: "run_a",
    repoDir,
    keep: true,
  });
});

test("the clone is ensured before the worktree is acquired", async () => {
  const order: string[] = [];
  await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat" },
    deps({
      ensureClone: async (options: { repoDir: string; remote: string }) => {
        order.push(`clone ${options.repoDir} ${options.remote}`);
      },
      acquire: async () => {
        order.push("acquire");
        return {
          path: target,
          branch: "feat",
          resolution: "new" as const,
          defaultBranch: "main",
          baseSha: "base1",
          headSha: "base1",
          behindDefault: 0,
        };
      },
      provision: async () => {},
    }),
  );
  expect(order).toEqual([`clone ${repoDir} ${binding.remote}`, "acquire"]);
});

test("the binding's own provisioning is what the worktree is provisioned with", async () => {
  const calls: ProvisionWorktreeOptions[] = [];
  await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat" },
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
  await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat" },
    deps({
      provision: async () => {},
      log: (line: string) => lines.push(line),
    }),
  );
  expect(lines).toContain(
    `[worktree] provisioned binding=api branch=feat path=${target}`,
  );
});

test("an unconfigured registry is refused before any disk work", async () => {
  await expect(
    provisionRequest(
      { runId: "run_a", binding: "api", branch: "feat" },
      { resolveBinding: () => binding },
    ),
  ).rejects.toThrow(WorktreeRegistryUnavailableError);
});
