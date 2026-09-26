// How the reviewed commit reaches GitHub under each identity. The git
// provider is a stand-in here: what is under test is the target jigs hands it,
// not what git does with it.

import { beforeEach, expect, test, vi } from "vitest";
import {
  git,
  pushBranch as gitPushBranch,
  headSha,
  pushCommit,
  resolveRemoteUrl,
} from "../../providers/git.ts";
import { githubAuthFor } from "../../providers/github-auth.ts";
import { pushApprovedChange, pushBranch } from "../git/branch.ts";
import { memoryRows } from "../runtime/test-fixtures.ts";

vi.mock("../../providers/git.ts", () => ({
  commitsAhead: vi.fn(),
  DEFAULT_PUSH_TARGET: { remote: "origin" },
  diffSince: vi.fn(),
  git: vi.fn().mockResolvedValue(""),
  headSha: vi.fn(),
  pushBranch: vi.fn(),
  pushCommit: vi.fn(),
  resolveRemoteUrl: vi.fn(),
}));
vi.mock("../../providers/github-auth.ts", () => ({ githubAuthFor: vi.fn() }));
vi.mock("workflow", () => ({ getWorkflowMetadata: () => ({ workflowRunId: "wrun_push" }) }));
vi.mock("../runtime/registry.ts", async () =>
  (await import("../runtime/test-fixtures.ts")).memoryRegistry(),
);

const worktree = {
  binding: "api",
  path: "/work",
  branch: "feature",
  defaultBranch: "main",
  baseSha: "base",
};

const APP = {
  mode: "app",
  appId: 1,
  installationId: 2,
  privateKeyPath: "/key.pem",
  operator: "salimhamed",
} as const;

const authAs = (identity: { mode: "pat" } | typeof APP, token = "ghs_installation") =>
  vi.mocked(githubAuthFor).mockReturnValue({ identity, bearer: async () => token });

const branches = () => memoryRows.map((row) => [row.kind, row.identity, row.url]);

beforeEach(() => {
  memoryRows.length = 0;
  vi.mocked(git).mockResolvedValue("");
  // The first push creates the branch; every later one updates it.
  vi.mocked(pushCommit).mockResolvedValue({ created: false });
  vi.mocked(gitPushBranch).mockResolvedValue({ created: false });
  vi.mocked(headSha).mockResolvedValue("approved");
  vi.mocked(resolveRemoteUrl).mockResolvedValue({
    remote: "origin",
    url: "git@github.com:acme/api.git",
  });
});

test("pat mode pushes to the binding's own remote, over SSH as the operator", async () => {
  authAs({ mode: "pat" });
  vi.mocked(pushCommit).mockResolvedValueOnce({ created: true });
  await pushApprovedChange(worktree, "approved");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", { remote: "origin" });
  await pushBranch(worktree);
  expect(gitPushBranch).toHaveBeenCalledWith("/work", "feature", { remote: "origin" });
  expect(branches()).toEqual([
    ["branch", "acme/api:feature", "https://github.com/acme/api/tree/feature"],
  ]);
});

test("a push that creates the branch records it, with the clone to ask about it", async () => {
  authAs({ mode: "pat" });
  vi.mocked(git).mockImplementation(async (args) =>
    args[0] === "rev-parse" ? "/data/clones/api/repo.git" : "",
  );
  vi.mocked(gitPushBranch).mockResolvedValueOnce({ created: true });
  await pushBranch(worktree);
  await pushApprovedChange(worktree, "approved");
  expect(memoryRows).toMatchObject([
    { kind: "branch", repoDir: "/data/clones/api/repo.git", branch: "feature" },
  ]);
});

test("a push to a branch that already existed records nothing", async () => {
  authAs({ mode: "pat" });
  await pushBranch(worktree);
  await pushApprovedChange(worktree, "approved");
  expect(branches()).toEqual([]);
});

test("app mode pushes over HTTPS, with the token beside the URL rather than in it", async () => {
  authAs(APP);
  await pushApprovedChange(worktree, "approved");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", {
    remote: "https://github.com/acme/api.git",
    token: "ghs_installation",
  });
});

test("an installation token can only push to GitHub, and says so", async () => {
  authAs(APP);
  vi.mocked(resolveRemoteUrl).mockResolvedValue({
    remote: "origin",
    url: "git@gitlab.com:acme/api.git",
  });
  await expect(pushApprovedChange(worktree, "approved")).rejects.toThrow("not a github.com remote");
});

test("a push that fails records nothing, and its retry records the branch it creates", async () => {
  authAs({ mode: "pat" });
  vi.mocked(gitPushBranch).mockRejectedValueOnce(new Error("connection reset"));
  await expect(pushBranch(worktree)).rejects.toThrow("connection reset");
  expect(branches()).toEqual([]);
  vi.mocked(gitPushBranch).mockResolvedValueOnce({ created: true });
  await pushBranch(worktree);
  expect(branches()).toEqual([
    ["branch", "acme/api:feature", "https://github.com/acme/api/tree/feature"],
  ]);
});
