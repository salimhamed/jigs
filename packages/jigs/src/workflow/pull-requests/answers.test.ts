import { expect, test, vi } from "vitest";
import type { CheckRun, PullRequestSnapshot } from "../../providers/github.ts";
import { postPullRequestNote, renderChecks } from "./answers.ts";
import { parseMarkers, type StatusReason } from "./marker.ts";

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_RUN", workflowName: "ship" }),
}));

const AT = "2026-08-26T12:00:00Z";
const SCOPE = "ship/AGE-403";

const failing: CheckRun[] = [{ name: "test", conclusion: "failure", url: "http://ci.test/1" }];

const pr = { owner: "acme", repo: "api", number: 41 };

function recorder(failOn: (body: string) => boolean = () => false) {
  const comments: string[] = [];
  return {
    comments,
    commentOnPullRequest: async (_pr: typeof pr, body: string) => {
      comments.push(body);
      if (failOn(body)) throw new Error("socket hang up");
      return { id: 8000 + comments.length };
    },
  };
}

// A pull request carrying no notes yet, so every note is new.
const unannotated = async (): Promise<PullRequestSnapshot> => ({
  state: "open",
  merged: false,
  draft: false,
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  headSha: "head-1",
  reviews: [],
  reviewThreads: [],
  conversationComments: [],
  ci: "green",
  failingChecks: [],
  approval: { signal: "review", state: "none" },
});

test("a note names the commit it settles, and a failed note does not throw", async () => {
  const posted = recorder();
  await postPullRequestNote({
    fetchPullRequestState: unannotated,
    commentOnPullRequest: posted.commentOnPullRequest,
    pr,
    scope: SCOPE,
    reason: "merge",
    headSha: "head-1",
    body: "I could not merge this pull request.",
  });
  expect(parseMarkers(posted.comments[0] ?? "")).toEqual([
    { scope: SCOPE, run: "wrun_RUN", kind: "status", reason: "merge", source: "head-1" },
  ]);

  const failing = recorder(() => true);
  await postPullRequestNote({
    fetchPullRequestState: unannotated,
    commentOnPullRequest: failing.commentOnPullRequest,
    pr,
    scope: SCOPE,
    reason: "ci",
    headSha: "head-1",
    body: "I could not repair the failing checks.",
  });
  // Nothing is thrown: the commit it describes is still red, and the next wake
  // says so again.
  expect(failing.comments).toHaveLength(1);
});

test("a repeated note for the same head and reason posts once", async () => {
  const posted = recorder();
  const recorded = async (): Promise<PullRequestSnapshot> => ({
    ...(await unannotated()),
    conversationComments: posted.comments.map((body, index) => ({
      id: 8001 + index,
      body,
      user: "salim",
      userType: "User",
      createdAt: AT,
      updatedAt: AT,
    })),
  });
  const note = (reason: StatusReason, headSha: string) =>
    postPullRequestNote({
      fetchPullRequestState: recorded,
      commentOnPullRequest: posted.commentOnPullRequest,
      pr,
      scope: SCOPE,
      reason,
      headSha,
      body: `I could not merge ${headSha} yet.`,
    });

  await note("merge-retry", "head-1");
  await note("merge-retry", "head-1");
  expect(posted.comments).toHaveLength(1);

  // Another reason, or another head, is another note.
  await note("merge", "head-1");
  await note("merge-retry", "head-2");
  expect(posted.comments).toHaveLength(3);
});

test("a red build the provider named no check for still renders something", () => {
  expect(renderChecks([])).toContain("without naming a check");
  expect(renderChecks(failing)).toBe("- **test** — failure — http://ci.test/1");
  // A commit status need not link anywhere.
  expect(renderChecks([{ name: "test", conclusion: "failure", url: "" }])).toBe(
    "- **test** — failure",
  );
});
