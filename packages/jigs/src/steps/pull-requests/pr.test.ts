import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MergeMethod, PullRequestSnapshot } from "../../providers/github.ts";
import {
  assignPullRequest,
  createPr,
  fetchAllowedMergeMethods,
  fetchPrCommitMessages,
  fetchPrSnapshot,
  fetchPrTitle,
  findOpenPullRequestByBranch,
  markPrReady,
  mergePr,
  postPullRequestReview,
} from "../../providers/github.ts";
import { githubAuthFor } from "../../providers/github-auth.ts";
import { GitHubApiError } from "../../providers/github-http.ts";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import {
  createPullRequest,
  markPullRequestReady,
  mergePullRequest,
  preservedCommitMessageBody,
  reviewPullRequest,
} from "./pr.ts";

vi.mock("../../providers/github.ts", () => ({
  assignPullRequest: vi.fn(),
  createPr: vi.fn(),
  fetchAllowedMergeMethods: vi.fn(),
  fetchPrCommitMessages: vi.fn(),
  fetchPrSnapshot: vi.fn(),
  fetchPrTitle: vi.fn(),
  findOpenPullRequestByBranch: vi.fn(),
  markPrReady: vi.fn(),
  mergePr: vi.fn(),
  postPullRequestReview: vi.fn(),
}));
vi.mock("../../providers/github-auth.ts", () => ({ githubAuthFor: vi.fn() }));

const pr = { owner: "owner", repo: "repo", number: 1 };
const repo = { owner: "owner", repo: "repo" };
const worktree = {
  binding: "app",
  path: "/work",
  branch: "fix",
  defaultBranch: "main",
  baseSha: "base",
};
let root: string;

const allowMethods = (...methods: MergeMethod[]) =>
  vi.mocked(fetchAllowedMergeMethods).mockResolvedValue(new Set(methods));

const writeConfig = (github: object = {}) =>
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default {
    hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9090 },
    github: ${JSON.stringify(github)},
    bindings: {
      app: { remote: "git@github.com:owner/repo.git" },
    },
  };`,
  );

const withOperator = (coAuthor?: string) =>
  writeConfig({ operator: "salimhamed", ...(coAuthor === undefined ? {} : { coAuthor }) });

// The provider reads facts; the step adds the approval.
const snapshot: Omit<PullRequestSnapshot, "approval" | "appBot"> = {
  state: "open",
  merged: false,
  draft: false,
  mergeState: "clean",
  labels: ["jigs:approved"],
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
  root = makeTmpDir();
  writeConfig();
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  vi.resetAllMocks();
  vi.mocked(githubAuthFor).mockReturnValue({
    bearer: async () => "token",
    invalidate: () => {},
    bot: async () => ({ login: "jigs[bot]", id: 1 }),
  });
  vi.mocked(fetchPrSnapshot).mockResolvedValue(snapshot);
  vi.mocked(fetchPrTitle).mockResolvedValue("fix: title");
  vi.mocked(fetchPrCommitMessages).mockResolvedValue([
    "fix: title\n\nThe body.\n\nBREAKING CHANGE: the shape moved.",
  ]);
  vi.mocked(findOpenPullRequestByBranch).mockResolvedValue(null);
  vi.mocked(createPr).mockResolvedValue({
    number: 1,
    html_url: "https://github.example/owner/repo/pull/1",
  });
  vi.mocked(mergePr).mockResolvedValue({ merged: true, sha: "merged" });
  allowMethods("squash", "merge", "rebase");
  vi.mocked(postPullRequestReview).mockResolvedValue({ id: 970 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(root);
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
  const error = new GitHubApiError(422, "/reviews", "Review cannot approve its own pull request");
  vi.mocked(postPullRequestReview).mockRejectedValue(error);

  await expect(reviewPullRequest(pr, { event: "approve", body: "Approved" })).rejects.toBe(error);
});

test("checks readiness again and pins the approved head on the merge call", async () => {
  expect(await mergePullRequest(pr, "head")).toEqual({
    merged: true,
    mergeCommitSha: "merged",
  });
  expect(mergePr).toHaveBeenCalledWith(pr, {
    title: "fix: title",
    expectedHeadSha: "head",
    method: "squash",
  });
});

test.each<[MergeMethod[], MergeMethod]>([
  [["squash", "merge", "rebase"], "squash"],
  [["merge", "rebase"], "merge"],
  [["rebase"], "rebase"],
])("with %j allowed, GitHub is asked for %s", async (allowed, method) => {
  allowMethods(...allowed);
  await mergePullRequest(pr, "head");
  expect(fetchAllowedMergeMethods).toHaveBeenCalledWith(pr);
  expect(mergePr).toHaveBeenCalledWith(pr, expect.objectContaining({ method }));
});

test("a repository that allows no merge method fails naming it", async () => {
  allowMethods();
  await expect(mergePullRequest(pr, "head")).rejects.toMatchObject({
    name: "JigsError",
    message: expect.stringContaining("owner/repo"),
    hint: expect.stringContaining("repository's settings"),
  });
  expect(mergePr).not.toHaveBeenCalled();
});

test("does not merge when the head or readiness changed after the gate wake", async () => {
  expect(await mergePullRequest(pr, "old")).toMatchObject({ merged: false });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, mergeState: "blocked" });
  expect(await mergePullRequest(pr, "head")).toMatchObject({ merged: false });
  expect(mergePr).not.toHaveBeenCalled();
});

test("a refusal says whether asking again could merge the same commit", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, mergeState: "unstable" });
  expect(await mergePullRequest(pr, "head")).toMatchObject({ transient: true });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, mergeState: "dirty" });
  expect(await mergePullRequest(pr, "head")).toMatchObject({ transient: false });
  vi.mocked(fetchPrSnapshot).mockResolvedValue({ ...snapshot, state: "closed" });
  expect(await mergePullRequest(pr, "head")).toMatchObject({ transient: false });
});

test("a pull request GitHub already merged is merged, not re-merged", async () => {
  vi.mocked(fetchPrSnapshot).mockResolvedValue({
    ...snapshot,
    merged: true,
    state: "closed",
    mergeCommitSha: "already",
  });
  expect(await mergePullRequest(pr, "head")).toEqual({
    merged: true,
    mergeCommitSha: "already",
  });
  expect(mergePr).not.toHaveBeenCalled();
});

test.each([405, 409])("a %i is state that changed, re-read rather than failed", async (status) => {
  vi.mocked(mergePr).mockRejectedValue(
    new GitHubApiError(status, "/merge", "Head branch was modified"),
  );
  // The re-read is what names the change, and a moved head is one the next
  // wake reads again.
  vi.mocked(fetchPrSnapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, headSha: "moved" });
  expect(await mergePullRequest(pr, "head")).toMatchObject({
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
    new GitHubApiError(405, "/merge", "Merge method not allowed"),
  );
  expect(await mergePullRequest(pr, "head")).toMatchObject({
    merged: false,
    transient: false,
  });
});

test("a refusal that GitHub then reports as merged is a merge", async () => {
  vi.mocked(mergePr).mockRejectedValue(
    new GitHubApiError(409, "/merge", "Head branch was modified"),
  );
  vi.mocked(fetchPrSnapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, merged: true, state: "closed", mergeCommitSha: "late" });
  expect(await mergePullRequest(pr, "head")).toEqual({
    merged: true,
    mergeCommitSha: "late",
  });
});

test("any other GitHub error is a real failure", async () => {
  vi.mocked(mergePr).mockRejectedValue(new GitHubApiError(500, "/merge", "boom"));
  await expect(mergePullRequest(pr, "head")).rejects.toThrow("500");
});

test("the co-author trailer follows preserved commit content", async () => {
  // `commit_message` replaces the body GitHub would generate, so jigs keeps
  // the commit content where the BREAKING CHANGE footer lives.
  withOperator("Salim Hamed <salim@example.com>");
  await mergePullRequest(pr, "head");
  expect(mergePr).toHaveBeenCalledWith(
    pr,
    expect.objectContaining({
      message:
        "The body.\n\nBREAKING CHANGE: the shape moved.\n\nCo-authored-by: Salim Hamed <salim@example.com>",
    }),
  );
});

test("the preservation policy keeps several commits in a bulleted list", async () => {
  withOperator("Salim Hamed <salim@example.com>");
  vi.mocked(fetchPrCommitMessages).mockResolvedValue([
    "feat: first\n\nWhy the first.",
    "fix: second",
  ]);
  await mergePullRequest(pr, "head");
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBe(
    "* feat: first\n\nWhy the first.\n\n* fix: second\n\nCo-authored-by: Salim Hamed <salim@example.com>",
  );
});

test("with no co-author configured GitHub writes its own body, unasked", async () => {
  withOperator();
  await mergePullRequest(pr, "head");
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
  expect(fetchPrCommitMessages).not.toHaveBeenCalled();
});

test("a rebase has no merge message to carry a trailer in", async () => {
  withOperator("Salim Hamed <salim@example.com>");
  allowMethods("rebase");
  await mergePullRequest(pr, "head");
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
});

test("with no operator or co-author, no trailer, no assignee and no requested-by line", async () => {
  expect(await createPullRequest({ worktree, title: "fix: search", body: "Body." })).toEqual({
    ...pr,
    url: "https://github.example/owner/repo/pull/1",
  });
  expect(findOpenPullRequestByBranch).toHaveBeenCalledExactlyOnceWith(repo, "fix", "main");
  expect(createPr).toHaveBeenCalledWith(expect.objectContaining({ body: "Body." }));
  expect(assignPullRequest).not.toHaveBeenCalled();
  await mergePullRequest(pr, "head");
  expect(vi.mocked(mergePr).mock.calls[0]?.[1].message).toBeUndefined();
});

test("an operator is named and assigned, and the provider's URL returned", async () => {
  withOperator();
  await expect(
    createPullRequest({ worktree, title: "fix: search", body: "Body." }),
  ).resolves.toEqual({ ...pr, url: "https://github.example/owner/repo/pull/1" });
  expect(findOpenPullRequestByBranch).toHaveBeenCalledExactlyOnceWith(repo, "fix", "main");
  expect(createPr).toHaveBeenCalledWith(
    expect.objectContaining({ body: "Requested by @salimhamed.\n\nBody." }),
  );
  expect(assignPullRequest).toHaveBeenCalledWith(pr, ["salimhamed"]);
});

test("createPullRequest forwards draft only when supplied", async () => {
  await createPullRequest({
    worktree,
    title: "fix: search",
    body: "Body.",
    draft: true,
  });
  expect(createPr).toHaveBeenLastCalledWith(expect.objectContaining({ draft: true }));

  await createPullRequest({ worktree, title: "fix: search", body: "Body." });
  expect(createPr).toHaveBeenLastCalledWith({
    owner: "owner",
    repo: "repo",
    head: "fix",
    base: "main",
    title: "fix: search",
    body: "Body.",
  });
});

test("an open pull request for the branch is adopted instead of created again", async () => {
  withOperator();
  vi.mocked(findOpenPullRequestByBranch).mockResolvedValue({
    ...pr,
    number: 7,
    url: "https://github.example/owner/repo/pull/7",
  });

  await expect(
    createPullRequest({ worktree, title: "fix: search", body: "Body." }),
  ).resolves.toEqual({ ...pr, number: 7, url: "https://github.example/owner/repo/pull/7" });
  expect(findOpenPullRequestByBranch).toHaveBeenCalledExactlyOnceWith(repo, "fix", "main");
  expect(createPr).not.toHaveBeenCalled();
  expect(assignPullRequest).toHaveBeenCalledWith({ ...pr, number: 7 }, ["salimhamed"]);
});

test("a failed assignment is not swallowed", async () => {
  withOperator();
  vi.mocked(assignPullRequest).mockRejectedValue(new GitHubApiError(403, "/assignees", "no"));

  await expect(
    createPullRequest({ worktree, title: "fix: search", body: "Body." }),
  ).rejects.toThrow("no");
  expect(createPr).toHaveBeenCalledOnce();
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
  vi.mocked(markPrReady).mockRejectedValue(new GitHubApiError(200, "/graphql", "not ready"));
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

test("opening a PR derives its repository, head and default branch from the supplied worktree", async () => {
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default {
    hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9090 },
    bindings: { docs: { remote: "git@github.com:acme/docs.git" } },
  };`,
  );
  await createPullRequest({
    worktree: { ...worktree, binding: "docs", branch: "update-guide", defaultBranch: "trunk" },
    title: "Update guide",
    body: "More examples.",
    draft: false,
  });
  expect(findOpenPullRequestByBranch).toHaveBeenCalledExactlyOnceWith(
    { owner: "acme", repo: "docs" },
    "update-guide",
    "trunk",
  );
  expect(createPr).toHaveBeenCalledExactlyOnceWith({
    owner: "acme",
    repo: "docs",
    head: "update-guide",
    base: "trunk",
    title: "Update guide",
    body: "More examples.",
    draft: false,
  });
});

test("an approval of an earlier commit merges only when the workflow lets it cover any commit", async () => {
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default {
    hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9090 },
    github: { operator: "salimhamed", mergeApproval: "review" },
    bindings: { app: { remote: "git@github.com:owner/repo.git" } },
  };`,
  );
  const approvedEarlier = (user: string) => ({
    ...snapshot,
    labels: [],
    reviews: [{ id: 1, user, state: "APPROVED", submittedAt: "today", body: "", commitSha: "old" }],
  });
  vi.mocked(fetchPrSnapshot).mockResolvedValue(approvedEarlier("person"));
  expect(await mergePullRequest(pr, "head")).toMatchObject({
    merged: false,
    reason: "the approval does not cover head",
  });
  expect(await mergePullRequest(pr, "head", { approvalCovers: "any-commit" })).toEqual({
    merged: true,
    mergeCommitSha: "merged",
  });

  // Agents act as the App's bot, so the operator's approval counts and a bot's never does.
  vi.mocked(fetchPrSnapshot).mockResolvedValue(approvedEarlier("salimhamed"));
  expect(await mergePullRequest(pr, "head", { approvalCovers: "any-commit" })).toMatchObject({
    merged: true,
  });
  vi.mocked(fetchPrSnapshot).mockResolvedValue(approvedEarlier("jigs-dev[bot]"));
  expect(await mergePullRequest(pr, "head", { approvalCovers: "any-commit" })).toMatchObject({
    merged: false,
    reason: "no approving review yet",
  });
});
