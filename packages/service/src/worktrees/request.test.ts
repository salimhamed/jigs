import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostCreateFailedError, type ResolvedBinding } from "jigs";
import type { Sql } from "postgres";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type AcquireWorktreeDeps,
  type AcquireWorktreeRequest,
  acquireWorktree,
} from "./acquire";
import type { WorktreeRow } from "./registry";
import { provisionRequest, WorktreeRegistryUnavailableError } from "./request";

// The same tagged-template fake acquire.test.ts uses, plus the UPDATE the
// provision-failed path issues.
function makeFakeSql(store: Map<string, WorktreeRow>): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$");
    if (query.includes("FROM jigs_worktrees")) {
      const row = store.get(values[0] as string);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    if (query.trimStart().startsWith("INSERT")) {
      const [
        rowPath,
        branch,
        ownerRunId,
        state,
        baseSha,
        headSha,
        behindDefault,
        checkoutRoot,
        keep,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        boolean,
      ];
      store.set(rowPath, {
        path: rowPath,
        branch,
        ownerRunId,
        state,
        baseSha,
        headSha,
        behindDefault,
        checkoutRoot,
        keep,
      });
      return Promise.resolve([]);
    }
    if (query.trimStart().startsWith("UPDATE")) {
      const [state, rowPath] = values as [string, string];
      const row = store.get(rowPath);
      if (row !== undefined) store.set(rowPath, { ...row, state });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.begin = (fn: (sql: unknown) => unknown) => Promise.resolve(fn(sql));
  return sql as unknown as Sql;
}

let tmp: string;
let checkout: string;
let workspace: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-request-test-"));
  checkout = path.join(tmp, "checkout");
  workspace = path.join(tmp, "workspace");
  store = new Map();
  // An ambient dev-database URL would otherwise make this lane open a real
  // connection and read the operator's registry.
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  vi.stubEnv("JIGS_FACTORY_ROOT", tmp);
  writeFileSync(path.join(tmp, "jigs.yml"), "bindings: {}\n");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const binding: ResolvedBinding = {
  name: "api",
  checkoutRoot: "",
  remote: "git@github.com:acme/api.git",
  ffDefaultBranch: true,
};

// The acquire seam keeps the registry write real (through the fake sql) while
// standing in for the git half; these tests are about what happens around it.
const deps = (overrides: Record<string, unknown> = {}) => ({
  sql: makeFakeSql(store),
  resolveBinding: () => ({
    ...binding,
    checkoutRoot: checkout,
    workspaceDir: workspace,
  }),
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
  fastForward: async () => ({ moved: false, skipped: "disabled" as const }),
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
  const row = store.get(path.join(workspace, "feat"));
  expect(row?.state).toBe("provision-failed");
});

test("a successful request registers the worktree as active", async () => {
  await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat", keep: true },
    deps({ provision: async () => ({ copied: [] }) }),
  );
  const row = store.get(path.join(workspace, "feat"));
  expect(row).toMatchObject({
    state: "active",
    ownerRunId: "run_a",
    checkoutRoot: checkout,
    keep: true,
  });
});

test("the fast-forward notice is logged, never thrown", async () => {
  const lines: string[] = [];
  await provisionRequest(
    { runId: "run_a", binding: "api", branch: "feat" },
    deps({
      provision: async () => ({ copied: [] }),
      fastForward: async () => ({ moved: false, skipped: "dirty" as const }),
      log: (line: string) => lines.push(line),
    }),
  );
  expect(lines[0]).toContain("dirty");
});

test("an unconfigured registry is refused before any disk work", async () => {
  await expect(
    provisionRequest(
      { runId: "run_a", binding: "api", branch: "feat" },
      { resolveBinding: () => binding },
    ),
  ).rejects.toThrow(WorktreeRegistryUnavailableError);
});
