import { beforeEach, expect, test, vi } from "vitest";
import type { MergePolicy } from "../../config/factory-config.ts";
import type { PrSnapshot } from "../../providers/github.ts";
import {
  assignPullRequest,
  createPullRequest,
  fetchPrCommitMessages,
  fetchPrSnapshot,
  fetchPrTitle,
  mergePr,
} from "../../providers/github.ts";
import { GithubApiError } from "../../providers/github-api.ts";
import { resolveGithubIdentity } from "../../providers/github-auth.ts";
import { defaultMergeBody, mergePullRequest, openPullRequest } from "./pr.ts";

vi.mock("../../providers/github.ts", () => ({
  assignPullRequest: vi.fn(),
  createPullRequest: vi.fn(),
  fetchPrCommitMessages: vi.fn(),
  fetchPrSnapshot: vi.fn(),
  fetchPrTitle: vi.fn(),
  mergePr: vi.fn(),
}));
vi.mock("../../providers/github-auth.ts", () => ({ resolveGithubIdentity: vi.fn() }));

const pr = { owner: "owner", repo: "repo", number: 1 };
const repo = { owner: "owner", repo: "repo" };
const SQUASH: MergePolicy = { by: "jigs", method: "squash", approval: { kind: "review" } };

const asApp = (coAuthor?: string) =>
  vi.mocked(resolveGithubIdentity).mockReturnValue({
    mode: "app",
    appId: 1,
    installationId: 2,
    privateKeyPath: "/key.pem",
    operator: "salimhamed",
    ...(coAuthor === undefined ? {} : { coAuthor }),
  });

const snapshot: PrSnapshot = {
  state: "open",
  merged: false,
  draft: false,
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  headSha: "head",
  ci: "green",
  failingChecks: [],
  reviewThreads: [],
  conversationComments: [],
  reviews: [
    { id: 1, user: "person", state: "APPROVED", submittedAt: "today", body: "", commitSha: "head" },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveGithubIdentity).mockReturnValue({ mode: "pat" });
  vi.mocked(fetchPrSnapshot).mockResolvedValue(snapshot);
  vi.mocked(fetchPrTitle).mockResolvedValue("fix: title");
  vi.mocked(fetchPrCommitMessages).mockResolvedValue([
    "fix: title\n\nThe body.\n\nBREAKING CHANGE: the shape moved.",
  ]);
  vi.mocked(createPullRequest).mockResolvedValue({ number: 1 });
  vi.mocked(mergePr).mockResolvedValue({ merged: true, sha: "merged" });
});

test("checks readiness again and pins the approved head on the merge call", async () => {
  expect(await mergePullRequest(pr, "head", SQUASH)).toEqual({
    merged: true,
    mergeCommitSha: "merged",
  });
  expect(mergePr).toHaveBeenCalledWith(pr, {
    title: "fix: title",
    expectedHeadSha: "head",
    method: "squash",
  });
});

test("the configured method is the one GitHub is asked for", async () => {
  await mergePullRequest(pr, "head", { ...SQUASH, method: "rebase" });
  expect(mergePr).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ method: "rebase" }),
  );
});

test("does not merge when the head or readiness changed after the gate wake", async () => {
  expect(await mergePullRequest(pr, "old", SQUASH)).toMatchObject({ merged: false });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, mergeState: "blocked" });
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({ merged: false });
  expect(mergePr).not.toHaveBeenCalled();
});

test("a refusal says whether asking again could merge the same commit", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, mergeState: "unstable" });
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({ transient: true });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, mergeState: "dirty" });
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({ transient: false });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, reviews: [] });
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({ transient: false });
});

test("a pull request GitHub already merged is merged, not re-merged", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue({
    ...snapshot,
    merged: true,
    state: "closed",
    mergeCommitSha: "already",
  });
  expect(await mergePullRequest(pr, "head", SQUASH)).toEqual({
    merged: true,
    mergeCommitSha: "already",
  });
  expect(mergePr).not.toHaveBeenCalled();
});

test.each([405, 409])("a %i is state that changed, re-read rather than failed", async (status) => {
  vi.mocked(mergePr).mockRejectedValue(
    new GithubApiError(status, "/merge", "Head branch was modified"),
  );
  // A state GitHub reports as changed is one the next wake reads again.
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({
    merged: false,
    transient: true,
  });
  // Whether it merged is GitHub's answer, never the status code's.
  expect(fetchPrSnapshot).toHaveBeenCalledTimes(2);
});

test("a refusal that GitHub then reports as merged is a merge", async () => {
  vi.mocked(mergePr).mockRejectedValue(
    new GithubApiError(409, "/merge", "Head branch was modified"),
  );
  vi.mocked(fetchPrSnapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, merged: true, state: "closed", mergeCommitSha: "late" });
  expect(await mergePullRequest(pr, "head", SQUASH)).toEqual({
    merged: true,
    mergeCommitSha: "late",
  });
});

test("any other GitHub error is a real failure", async () => {
  vi.mocked(mergePr).mockRejectedValue(new GithubApiError(500, "/merge", "boom"));
  await expect(mergePullRequest(pr, "head", SQUASH)).rejects.toThrow("500");
});

test("the co-author trailer is appended to GitHub's own body, never sent instead of it", async () => {
  // `commit_message` replaces the body GitHub would write, and that body is
  // where the BREAKING CHANGE footer release-please reads lives.
  asApp("Salim Hamed <salim@example.com>");
  await mergePullRequest(pr, "head", SQUASH);
  expect(mergePr).toHaveBeenCalledWith(
    pr,
    expect.objectContaining({
      message:
        "The body.\n\nBREAKING CHANGE: the shape moved.\n\nCo-authored-by: Salim Hamed <salim@example.com>",
    }),
  );
});

test("several commits become the bulleted list GitHub would have written", async () => {
  asApp("Salim Hamed <salim@example.com>");
  vi.mocked(fetchPrCommitMessages).mockResolvedValue([
    "feat: first\n\nWhy the first.",
    "fix: second",
  ]);
  await mergePullRequest(pr, "head", SQUASH);
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBe(
    "* feat: first\n\nWhy the first.\n\n* fix: second\n\nCo-authored-by: Salim Hamed <salim@example.com>",
  );
});

test("with no co-author configured GitHub writes its own body, unasked", async () => {
  asApp();
  await mergePullRequest(pr, "head", SQUASH);
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
  expect(fetchPrCommitMessages).not.toHaveBeenCalled();
});

test("a rebase has no merge message to carry a trailer in", async () => {
  asApp("Salim Hamed <salim@example.com>");
  await mergePullRequest(pr, "head", { ...SQUASH, method: "rebase" });
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
});

test("pat mode adds no trailer, no assignee and no requested-by line", async () => {
  expect(await openPullRequest(repo, "fix", "main", "fix: search", "Body.")).toEqual(pr);
  expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ body: "Body." }));
  expect(assignPullRequest).not.toHaveBeenCalled();
  await mergePullRequest(pr, "head", SQUASH);
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
});

test("app mode names the operator on the pull request it opens for them", async () => {
  asApp();
  await openPullRequest(repo, "fix", "main", "fix: search", "Body.");
  expect(createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ body: "Requested by @salimhamed.\n\nBody." }),
  );
  expect(assignPullRequest).toHaveBeenCalledWith(pr, ["salimhamed"]);
});

test("defaultMergeBody reproduces what GitHub composes for itself", () => {
  // One commit: its body, without the subject GitHub puts in the title.
  expect(defaultMergeBody(["fix: thing\n\nWhy.\n\nBREAKING CHANGE: moved."])).toBe(
    "Why.\n\nBREAKING CHANGE: moved.",
  );
  expect(defaultMergeBody(["fix: thing"])).toBe("");
  // Several: a bullet per commit, each keeping its own body.
  expect(defaultMergeBody(["feat: a\n\nBecause.", "fix: b"])).toBe(
    "* feat: a\n\nBecause.\n\n* fix: b",
  );
  expect(defaultMergeBody([])).toBe("");
});
