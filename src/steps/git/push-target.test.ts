// How the reviewed commit reaches GitHub under each identity. The git
// provider is a stand-in here: what is under test is the target jigs hands it,
// not what git does with it. Credentials come from a real factory config, so a
// lookup that runs too early fails here as it would in a factory.

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
vi.mock("../../providers/github-auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/github-auth.ts")>();
  return { ...actual, githubAuthFor: vi.fn(actual.githubAuthFor) };
});
vi.mock("workflow", () => ({ getWorkflowMetadata: () => ({ workflowRunId: "wrun_push" }) }));
vi.mock("../runtime/registry.ts", async () =>
  (await import("../runtime/test-fixtures.ts")).memoryRegistry(),
);
vi.mock("../../config/factory-context.ts", async (original) =>
  (await import("../runtime/test-fixtures.ts")).memoryFactoryContext(original as never),
);

const worktree = {
  binding: "api",
  path: "/work",
  branch: "feature",
  defaultBranch: "main",
  baseSha: "base",
};

const PAT = `{ mode: "pat" }`;
const APP = `{ mode: "app", appId: 1, privateKeyPath: "key.pem", operator: "salimhamed", installations: { acme: 2 } }`;

let factory: string;
function configure(identity: string) {
  writeFileSync(
    `${factory}/jigs.config.ts`,
    `export default { service: { dashboardPort: 9090 }, github: { identities: [${identity}] } }`,
  );
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
}

const remote = (url: string) =>
  vi.mocked(resolveRemoteUrl).mockResolvedValue({ remote: "origin", url });

const branches = () => memoryRows.map((row) => [row.kind, row.identity, row.url]);

beforeEach(() => {
  factory = makeTmpDir();
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

test("pat mode pushes to the binding's own remote, over SSH as the operator", async () => {
  configure(PAT);
  vi.mocked(pushCommit).mockResolvedValueOnce({ created: true });
  await pushApprovedChange(worktree, "approved");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", { remote: "origin" });
  await pushBranch(worktree);
  expect(gitPushBranch).toHaveBeenCalledWith("/work", "feature", { remote: "origin" });
  expect(branches()).toEqual([
    ["branch", "acme/api:feature", "https://github.com/acme/api/tree/feature"],
  ]);
});

test("pat mode pushes to a remote outside GitHub as it is", async () => {
  configure(PAT);
  remote("git@gitlab.com:acme/api.git");
  await pushApprovedChange(worktree, "approved");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", { remote: "origin" });
});

test("a push that creates the branch records it, with the clone to ask about it", async () => {
  configure(PAT);
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
  configure(PAT);
  await pushBranch(worktree);
  await pushApprovedChange(worktree, "approved");
  expect(branches()).toEqual([]);
});

test("app mode pushes over HTTPS, with the token beside the URL rather than in it", async () => {
  configure(APP);
  const { identity } = githubAuthFor("acme");
  vi.mocked(githubAuthFor).mockReturnValueOnce({
    identity,
    bearer: async () => "ghs_installation",
  });
  await pushApprovedChange(worktree, "approved");
  expect(githubAuthFor).toHaveBeenLastCalledWith("acme");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", {
    remote: "https://github.com/acme/api.git",
    token: "ghs_installation",
  });
});

test("an installation token can only push to GitHub, and says so", async () => {
  configure(APP);
  remote("git@gitlab.com:acme/api.git");
  await expect(pushApprovedChange(worktree, "approved")).rejects.toThrow("not a github.com remote");
  expect(pushCommit).not.toHaveBeenCalled();
});

test("a push that fails records nothing, and its retry records the branch it creates", async () => {
  configure(PAT);
  vi.mocked(gitPushBranch).mockRejectedValueOnce(new Error("connection reset"));
  await expect(pushBranch(worktree)).rejects.toThrow("connection reset");
  expect(branches()).toEqual([]);
  vi.mocked(gitPushBranch).mockResolvedValueOnce({ created: true });
  await pushBranch(worktree);
  expect(branches()).toEqual([
    ["branch", "acme/api:feature", "https://github.com/acme/api/tree/feature"],
  ]);
});
