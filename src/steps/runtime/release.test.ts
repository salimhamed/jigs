import { beforeEach, expect, test, vi } from "vitest";
import type { ReleasePolicy } from "../../workflow/runtime/release.ts";

const mocks = vi.hoisted(() => ({
  resolveReleasePolicy: vi.fn(),
  applyRelease: vi.fn(),
  writeCleanupDirective: vi.fn(),
}));

vi.mock("./release-policy.ts", () => ({ resolveReleasePolicy: mocks.resolveReleasePolicy }));
vi.mock("./cleanup-state.ts", () => ({
  writeCleanupDirective: mocks.writeCleanupDirective,
  writeCleanupProgress: vi.fn(),
}));
vi.mock("../workspaces/release.ts", () => ({ releaseRunResources: mocks.applyRelease }));
vi.mock("../workspaces/sql.ts", () => ({ registrySql: () => ({}) }));
vi.mock("../workspaces/registry.ts", () => ({
  withRunResourceLock: (_sql: unknown, _runId: string, action: (sql: unknown) => unknown) =>
    action({}),
}));
vi.mock("workflow/runtime", () => ({
  getWorld: async () => ({ runs: { get: async () => ({ attributes: {} }) } }),
}));

const { releaseRunResources } = await import("./release.ts");

const keep = { onSuccess: "keep", onFailure: "keep" } as const;
const discard = { onSuccess: "release", onFailure: "release" } as const;
const metadata = { workflowRunId: "run_1", workflowName: "compiled" };
const definition = { service: { dashboardPort: 9000 }, workflows: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveReleasePolicy.mockResolvedValue(discard);
  mocks.applyRelease.mockImplementation(async (policy: ReleasePolicy) => ({
    policy,
    worktrees: [],
    runDirectory: { path: "scratch", removed: false, reason: "kept" },
  }));
});

test("an explicit policy wins without reading the configured one", async () => {
  const report = await releaseRunResources(metadata, definition, keep);
  expect(mocks.resolveReleasePolicy).not.toHaveBeenCalled();
  expect(mocks.writeCleanupDirective).toHaveBeenCalledWith("run_1", "keep");
  expect(report.policy).toEqual(keep);
});

test("without a policy, the configured one is resolved and applied", async () => {
  const report = await releaseRunResources(metadata, definition);
  expect(mocks.resolveReleasePolicy).toHaveBeenCalledWith(metadata, definition);
  expect(mocks.writeCleanupDirective).toHaveBeenCalledWith("run_1", "release");
  expect(report.policy).toEqual(discard);
});
