import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { MergePolicy } from "../../blocks/pull-requests/policy.ts";
import type { PullRequestSnapshot } from "../../providers/github.ts";
import {
  assignPullRequest,
  createPullRequest,
  fetchPrCommitMessages,
  fetchPrSnapshot,
  fetchPrTitle,
  markPrReady,
  mergePr,
  postPullRequestReview,
} from "../../providers/github.ts";
import { GithubApiError } from "../../providers/github-api.ts";
import { resolveGithubIdentity } from "../../providers/github-auth.ts";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import {
  markPullRequestReady,
  mergePullRequest,
  openPullRequest,
  preservedCommitMessageBody,
  resolveMergePolicy,
  reviewPullRequest,
} from "./pr.ts";

vi.mock("../../providers/github.ts", () => ({
  assignPullRequest: vi.fn(),
  createPullRequest: vi.fn(),
  fetchPrCommitMessages: vi.fn(),
  fetchPrSnapshot: vi.fn(),
  fetchPrTitle: vi.fn(),
  markPrReady: vi.fn(),
  mergePr: vi.fn(),
  postPullRequestReview: vi.fn(),
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

const snapshot: PullRequestSnapshot = {
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

test("resolveMergePolicy applies a named binding's overrides to the factory policy", async () => {
  const root = makeTmpDir();
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default {
      service: { dashboardPort: 9090 },
      merge: { by: "jigs", method: "squash", approval: { kind: "review" } },
      bindings: { docs: { remote: "git@github.com:acme/docs.git", merge: { by: "human", method: "rebase" } } },
    };`,
  );
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  try {
    await expect(resolveMergePolicy("docs")).resolves.toEqual({
      by: "human",
      method: "rebase",
      approval: { kind: "review" },
    });
  } finally {
    vi.unstubAllEnvs();
    removeTmpDir(root);
  }
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveGithubIdentity).mockReturnValue({ mode: "pat" });
  vi.mocked(fetchPrSnapshot).mockResolvedValue(snapshot);
  vi.mocked(fetchPrTitle).mockResolvedValue("fix: title");
  vi.mocked(fetchPrCommitMessages).mockResolvedValue([
    "fix: title\n\nThe body.\n\nBREAKING CHANGE: the shape moved.",
  ]);
  vi.mocked(createPullRequest).mockResolvedValue({
    number: 1,
    html_url: "https://github.example/owner/repo/pull/1",
  });
  vi.mocked(mergePr).mockResolvedValue({ merged: true, sha: "merged" });
  vi.mocked(postPullRequestReview).mockResolvedValue({ id: 970 });
});

test("reviewPullRequest returns the provider's review id", async () => {
  const review = {
    event: "comment" as const,
    body: "Summary",
    comments: [{ path: "src/file.ts", line: 12, body: "Change this" }],
  };
  await expect(reviewPullRequest(pr, review)).resolves.toEqual({ id: 970 });
  expect(postPullRequestReview).toHaveBeenCalledExactlyOnceWith(pr, review);
});

test("reviewPullRequest surfaces a GitHub error unchanged", async () => {
  const error = new GithubApiError(422, "/reviews", "Review cannot approve its own pull request");
  vi.mocked(postPullRequestReview).mockRejectedValue(error);

  await expect(reviewPullRequest(pr, { event: "approve", body: "Approved" })).rejects.toBe(error);
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
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, state: "closed" });
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
  // The re-read is what names the change, and a moved head is one the next
  // wake reads again.
  vi.mocked(fetchPrSnapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, headSha: "moved" });
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({
    merged: false,
    transient: true,
  });
  // Whether it merged is GitHub's answer, never the status code's.
  expect(fetchPrSnapshot).toHaveBeenCalledTimes(2);
});

test("a refusal nothing in the snapshot explains is not tried again", async () => {
  // The squash method disabled on the repository, or a protection GitHub does
  // not express in `mergeable_state`: the pull request still reads clean, and
  // no later wake would read it differently.
  vi.mocked(mergePr).mockRejectedValue(
    new GithubApiError(405, "/merge", "Merge method not allowed"),
  );
  expect(await mergePullRequest(pr, "head", SQUASH)).toMatchObject({
    merged: false,
    transient: false,
  });
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

test("the co-author trailer follows preserved commit content", async () => {
  // `commit_message` replaces the body GitHub would generate, so jigs keeps
  // the commit content where the BREAKING CHANGE footer lives.
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

test("the preservation policy keeps several commits in a bulleted list", async () => {
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
  expect(
    await openPullRequest({ repo, head: "fix", base: "main", title: "fix: search", body: "Body." }),
  ).toEqual({ ...pr, url: "https://github.example/owner/repo/pull/1" });
  expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ body: "Body." }));
  expect(assignPullRequest).not.toHaveBeenCalled();
  await mergePullRequest(pr, "head", SQUASH);
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
});

test("app mode names the operator and returns the provider's URL", async () => {
  asApp();
  await expect(
    openPullRequest({ repo, head: "fix", base: "main", title: "fix: search", body: "Body." }),
  ).resolves.toEqual({ ...pr, url: "https://github.example/owner/repo/pull/1" });
  expect(createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ body: "Requested by @salimhamed.\n\nBody." }),
  );
  expect(assignPullRequest).toHaveBeenCalledWith(pr, ["salimhamed"]);
});

test("openPullRequest forwards draft only when supplied", async () => {
  await openPullRequest({
    repo,
    head: "fix",
    base: "main",
    title: "fix: search",
    body: "Body.",
    draft: true,
  });
  expect(createPullRequest).toHaveBeenLastCalledWith(expect.objectContaining({ draft: true }));

  await openPullRequest({ repo, head: "fix", base: "main", title: "fix: search", body: "Body." });
  expect(createPullRequest).toHaveBeenLastCalledWith({
    owner: "owner",
    repo: "repo",
    head: "fix",
    base: "main",
    title: "fix: search",
    body: "Body.",
  });
});

test("markPullRequestReady mutates before returning a fresh snapshot", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, draft: false, headSha: "fresh" });
  await expect(markPullRequestReady(pr)).resolves.toMatchObject({ draft: false, headSha: "fresh" });
  expect(markPrReady).toHaveBeenCalledExactlyOnceWith(pr);
  expect(fetchPrSnapshot).toHaveBeenCalledExactlyOnceWith(pr);
  expect(vi.mocked(markPrReady).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(fetchPrSnapshot).mock.invocationCallOrder[0] ?? 0,
  );
});

test("markPullRequestReady does not read success after a mutation failure", async () => {
  vi.mocked(markPrReady).mockRejectedValue(new GithubApiError(200, "/graphql", "not ready"));
  await expect(markPullRequestReady(pr)).rejects.toThrow("not ready");
  expect(fetchPrSnapshot).not.toHaveBeenCalled();
});

test("preservedCommitMessageBody keeps useful commit-message content", () => {
  // One commit: its body, because jigs sends the pull request title separately.
  expect(preservedCommitMessageBody(["fix: thing\n\nWhy.\n\nBREAKING CHANGE: moved."])).toBe(
    "Why.\n\nBREAKING CHANGE: moved.",
  );
  expect(preservedCommitMessageBody(["fix: thing"])).toBe("");
  // Several: a bullet per commit, each keeping its own body.
  expect(preservedCommitMessageBody(["feat: a\n\nBecause.", "fix: b"])).toBe(
    "* feat: a\n\nBecause.\n\n* fix: b",
  );
  expect(preservedCommitMessageBody([])).toBe("");
});
