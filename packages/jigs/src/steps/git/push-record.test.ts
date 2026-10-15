// Which pushes record a branch for the run. The git provider is a stand-in
// here: what is under test is the record, not what git does.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { git, pushBranch as gitPushBranch, headSha, pushCommit } from "../../providers/git.ts";
import { removeTmpDir, useTestFactory } from "../../test-fixtures.ts";
import { memoryRows } from "../runtime/test-fixtures.ts";
import { pushApprovedChange, pushBranch } from "./branch.ts";

vi.mock("../../providers/git.ts", () => ({
  commitsAhead: vi.fn(),
  diffSince: vi.fn(),
  git: vi.fn().mockResolvedValue(""),
  headSha: vi.fn(),
  pushBranch: vi.fn(),
  pushCommit: vi.fn(),
}));
vi.mock("workflow", () => ({ getWorkflowMetadata: () => ({ workflowRunId: "wrun_push" }) }));
vi.mock("../runtime/registry.ts", async () =>
  (await import("../runtime/test-fixtures.ts")).memoryRegistry(),
);
vi.mock("../../config/factory-context.ts", async (original) =>
  (await import("../runtime/test-fixtures.ts")).memoryFactoryContext(original as never),
);

const worktree = {
  binding: "api",
  installationName: "github-acme",
  path: "/work",
  branch: "feature",
  defaultBranch: "main",
  baseSha: "base",
};

let factory: string;

const branches = () => memoryRows.map((row) => [row.kind, row.identity, row.url]);

beforeEach(() => {
  factory = useTestFactory(`export default { hub: { url: "https://hub.example.test" } }`);
  memoryRows.length = 0;
  vi.mocked(git).mockImplementation(
    async (args) =>
      ({ "rev-parse": "/data/clones/api/repo.git", config: "https://github.com/acme/api.git" })[
        args[0] ?? ""
      ] ?? "",
  );
  // The first push creates the branch; every later one updates it.
  vi.mocked(pushCommit).mockReset().mockResolvedValue({ created: false });
  vi.mocked(gitPushBranch).mockReset().mockResolvedValue({ created: false });
  vi.mocked(headSha).mockResolvedValue("approved");
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(factory);
});

test("a push that creates the branch records it, with the clone to ask about it", async () => {
  vi.mocked(gitPushBranch).mockResolvedValueOnce({ created: true });
  await pushBranch(worktree);
  await pushApprovedChange(worktree, "approved");
  expect(memoryRows).toMatchObject([
    { kind: "branch", repoDir: "/data/clones/api/repo.git", branch: "feature" },
  ]);
});

test("a push to a branch that already existed records nothing", async () => {
  await pushBranch(worktree);
  await pushApprovedChange(worktree, "approved");
  expect(branches()).toEqual([]);
});

test("a push that fails records nothing, and its retry records the branch it creates", async () => {
  vi.mocked(gitPushBranch).mockRejectedValueOnce(new Error("connection reset"));
  await expect(pushBranch(worktree)).rejects.toThrow("connection reset");
  expect(branches()).toEqual([]);
  vi.mocked(gitPushBranch).mockResolvedValueOnce({ created: true });
  await pushBranch(worktree);
  expect(branches()).toEqual([
    ["branch", "acme/api:feature", "https://github.com/acme/api/tree/feature"],
  ]);
});
