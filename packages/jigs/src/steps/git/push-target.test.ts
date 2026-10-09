// How the reviewed commit reaches its remote. The git provider is a stand-in
// here: what is under test is the target jigs hands it, not what git does with
// it.

import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  git,
  pushBranch as gitPushBranch,
  headSha,
  pushCommit,
  resolveRemoteUrl,
} from "../../providers/git.ts";
import { githubAuthFor } from "../../providers/github-auth.ts";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { memoryRows } from "../runtime/test-fixtures.ts";
import { pushApprovedChange, pushBranch } from "./branch.ts";

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
vi.mock("../../providers/github-auth.ts", () => ({
  githubAuthFor: vi.fn(() => ({ bearer: async () => "ghs_installation" })),
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

const remote = (url: string) =>
  vi.mocked(resolveRemoteUrl).mockResolvedValue({ remote: "origin", url });

const branches = () => memoryRows.map((row) => [row.kind, row.identity, row.url]);

beforeEach(() => {
  factory = makeTmpDir();
  writeFileSync(
    `${factory}/jigs.config.ts`,
    `export default { hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9090 } }`,
  );
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
  memoryRows.length = 0;
  vi.mocked(git).mockResolvedValue("");
  // The first push creates the branch; every later one updates it.
  vi.mocked(pushCommit).mockReset().mockResolvedValue({ created: false });
  vi.mocked(gitPushBranch).mockReset().mockResolvedValue({ created: false });
  vi.mocked(headSha).mockResolvedValue("approved");
  remote("git@github.com:acme/api.git");
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(factory);
});

test("a GitHub remote is pushed to over HTTPS, with the token beside the URL rather than in it", async () => {
  vi.mocked(pushCommit).mockResolvedValueOnce({ created: true });
  await pushApprovedChange(worktree, "approved");
  expect(githubAuthFor).toHaveBeenLastCalledWith("github-acme");
  const target = { remote: "https://github.com/acme/api.git", token: "ghs_installation" };
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", target);
  await pushBranch(worktree);
  expect(gitPushBranch).toHaveBeenCalledWith("/work", "feature", target);
  expect(branches()).toEqual([
    ["branch", "acme/api:feature", "https://github.com/acme/api/tree/feature"],
  ]);
});

test("a remote outside GitHub is pushed to as it is, as the operator", async () => {
  remote("git@gitlab.com:acme/api.git");
  await pushApprovedChange(worktree, "approved");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", { remote: "origin" });
});

test("a push that creates the branch records it, with the clone to ask about it", async () => {
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
