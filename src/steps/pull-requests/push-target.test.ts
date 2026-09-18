// How the reviewed commit reaches GitHub under each identity. The git
// provider is a stand-in here: what is under test is the target jigs hands it,
// not what git does with it.

import { beforeEach, expect, test, vi } from "vitest";
import {
  pushBranch as gitPushBranch,
  headSha,
  pushCommit,
  resolveRemoteUrl,
} from "../../providers/git.ts";
import { githubAuthFor } from "../../providers/github-auth.ts";
import { pushApprovedChange, pushBranch } from "../git/branch.ts";

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

const APP = {
  mode: "app",
  appId: 1,
  installationId: 2,
  privateKeyPath: "/key.pem",
  operator: "salimhamed",
} as const;

const authAs = (identity: { mode: "pat" } | typeof APP, token = "ghs_installation") =>
  vi.mocked(githubAuthFor).mockReturnValue({ identity, bearer: async () => token });

beforeEach(() => {
  vi.mocked(headSha).mockResolvedValue("approved");
  vi.mocked(resolveRemoteUrl).mockResolvedValue({
    remote: "origin",
    url: "git@github.com:acme/api.git",
  });
});

test("pat mode pushes to the binding's own remote, over SSH as the operator", async () => {
  authAs({ mode: "pat" });
  await pushApprovedChange("/work", "feature", "approved");
  expect(pushCommit).toHaveBeenCalledWith("/work", "feature", "approved", { remote: "origin" });
  await pushBranch("/work", "feature");
  expect(gitPushBranch).toHaveBeenCalledWith("/work", "feature", { remote: "origin" });
});

test("app mode pushes over HTTPS, with the token beside the URL rather than in it", async () => {
  authAs(APP);
  await pushApprovedChange("/work", "feature", "approved");
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
  await expect(pushApprovedChange("/work", "feature", "approved")).rejects.toThrow(
    "not a github.com remote",
  );
});
