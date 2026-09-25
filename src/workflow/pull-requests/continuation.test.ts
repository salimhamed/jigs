// The scripted failure the markers exist for: a run answers part of the
// feedback, loses the response to one of its replies, and ends; a replacement
// run picks the pull request up and finishes exactly what is left. Everything
// here runs against a pull request that keeps what is posted to it, because
// that record is the only thing the two runs share.

import { expect, test, vi } from "vitest";
import type {
  PullRequestComment,
  PullRequestReview,
  PullRequestSnapshot,
  ReviewThread,
} from "../../providers/github.ts";
import { postPullRequestNote, postReviewAnswers } from "./answers.ts";
import { classifyPullRequestState } from "./gate.ts";
import type { MergeApproval } from "./policy.ts";

const APPROVAL: MergeApproval = "review";

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_A", workflowName: "ship" }),
}));

const AT = "2026-09-14T01:00:00Z";
const SHIP = "ship/AGE-403";
const REVIEW = "review/outstanding";
const pr = { owner: "acme", repo: "api", number: 41 };

function fakePullRequest() {
  const threads: ReviewThread[] = [];
  const conversation: PullRequestComment[] = [];
  const reviews: PullRequestReview[] = [];
  const state = {
    headSha: "head-1",
    ci: "pending" as PullRequestSnapshot["ci"],
    open: true,
    merged: false,
    mergeState: "clean",
  };
  let nextId = 5000;

  const ask = (body: string, updatedAt = AT): number => {
    const id = ++nextId;
    threads.push({
      rootId: id,
      path: "src/gate.ts",
      line: 3,
      comments: [
        {
          id,
          rootId: id,
          body,
          user: "salim",
          path: "src/gate.ts",
          line: 3,
          createdAt: AT,
          updatedAt,
        },
      ],
    });
    return id;
  };

  return {
    threads,
    conversation,
    ask,
    edit(rootId: number, body: string, updatedAt: string) {
      const target = threads.find((thread) => thread.rootId === rootId)?.comments[0];
      if (target === undefined) throw new Error(`no comment ${rootId}`);
      target.body = body;
      target.updatedAt = updatedAt;
    },
    reply: async (_target: typeof pr, rootId: number, body: string) => {
      const id = ++nextId;
      threads
        .find((thread) => thread.rootId === rootId)
        ?.comments.push({
          id,
          rootId,
          body,
          user: "salim",
          path: "src/gate.ts",
          line: 3,
          createdAt: AT,
          updatedAt: AT,
        });
      return { id };
    },
    comment: async (_target: typeof pr, body: string) => {
      const id = ++nextId;
      conversation.push({
        id,
        body,
        user: "salim",
        userType: "User",
        createdAt: AT,
        updatedAt: AT,
      });
      return { id };
    },
    push(sha: string) {
      state.headSha = sha;
    },
    approve(sha: string) {
      reviews.push({
        id: ++nextId,
        state: "APPROVED",
        body: "",
        user: "salim",
        submittedAt: AT,
        commitSha: sha,
      });
    },
    dismiss() {
      const last = reviews.at(-1);
      if (last !== undefined) last.state = "DISMISSED";
    },
    setCi(ci: PullRequestSnapshot["ci"]) {
      state.ci = ci;
    },
    setMergeState(mergeState: string) {
      state.mergeState = mergeState;
    },
    snapshot: async (): Promise<PullRequestSnapshot> => ({
      state: state.open ? "open" : "closed",
      merged: state.merged,
      draft: false,
      mergeState: state.mergeState,
      labels: [],
      mergeCommitSha: null,
      headSha: state.headSha,
      reviews: reviews.map((review) => ({ ...review })),
      reviewThreads: threads.map((thread) => ({ ...thread, comments: [...thread.comments] })),
      conversationComments: conversation.map((comment) => ({ ...comment })),
      ci: state.ci,
      failingChecks: state.ci === "red" ? [{ name: "build", conclusion: "failure", url: "" }] : [],
    }),
  };
}

const outstandingThreads = async (github: ReturnType<typeof fakePullRequest>, scope: string) => {
  const [wake] = classifyPullRequestState(await github.snapshot(), scope, APPROVAL).wakes;
  return wake?.kind === "review-comments" ? wake.threads.map((thread) => thread.rootId) : [];
};

test("a replacement run answers only what the pull request does not already carry", async () => {
  const github = fakePullRequest();
  const first = github.ask("rename this");
  const second = github.ask("and the caller too");

  // Round one: both items are outstanding.
  expect(await outstandingThreads(github, SHIP)).toEqual([first, second]);

  // The run answers the first and pushes a commit; the reply to the second
  // reaches GitHub and the response is lost, so the step throws. The wake ends
  // there — the run does not fail, and nothing is retried.
  const wake = classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes[0];
  if (wake?.kind !== "review-comments") throw new Error("expected feedback");
  github.push("head-2");
  await postReviewAnswers({
    replyToPullRequestReviewThread: github.reply,
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    answers: {
      answers: [{ threadId: first, body: "renamed" }],
      commitExplanation: "Renamed the function and ran the tests.",
    },
    committedSha: "head-2",
    threads: wake.threads,
  });
  await postReviewAnswers({
    replyToPullRequestReviewThread: async (target, rootId, body) => {
      await github.reply(target, rootId, body);
      throw new Error("socket hang up");
    },
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    answers: { answers: [{ threadId: second, body: "done" }], commitExplanation: null },
    threads: wake.threads,
  });

  // Both answers are on the pull request, so the next wake — this run's or a
  // replacement's — owes nothing, including for the reply whose response never
  // came back. That is post-once: the read at the start of the wake is the
  // only check there is.
  expect(await outstandingThreads(github, SHIP)).toEqual([]);

  // The commit explanation is jigs' own comment, not feedback, and the answered
  // threads stay answered however often the same state is delivered.
  const twice = classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL);
  expect(twice.wakes).toEqual([]);
  expect(twice.ownComments).toBe(3);

  // An independent workflow reading the same pull request sees the questions as
  // unanswered work of its own, and jigs' comments as nobody's feedback.
  expect(await outstandingThreads(github, REVIEW)).toEqual([first, second]);

  // Editing a question makes it outstanding again: the answer named the text
  // that was there before.
  github.edit(first, "rename this, and document it", "2026-09-14T02:00:00Z");
  expect(await outstandingThreads(github, SHIP)).toEqual([first]);
});

test("a reply that never landed is posted by the next wake, not lost", async () => {
  const github = fakePullRequest();
  const asked = github.ask("rename this");

  const wake = classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes[0];
  if (wake?.kind !== "review-comments") throw new Error("expected feedback");
  // The write failed before GitHub saw it: nothing on the pull request.
  await postReviewAnswers({
    replyToPullRequestReviewThread: async () => {
      throw new Error("connect ETIMEDOUT");
    },
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    answers: { answers: [{ threadId: asked, body: "renamed" }], commitExplanation: null },
    threads: wake.threads,
  });
  expect(github.threads[0]?.comments).toHaveLength(1);

  // So the question is still outstanding, and the next wake — a webhook, or
  // the next poll — answers it.
  expect(await outstandingThreads(github, SHIP)).toEqual([asked]);
  const again = classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes[0];
  if (again?.kind !== "review-comments") throw new Error("expected feedback");
  await postReviewAnswers({
    replyToPullRequestReviewThread: github.reply,
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    answers: { answers: [{ threadId: asked, body: "renamed" }], commitExplanation: null },
    threads: again.threads,
  });
  expect(await outstandingThreads(github, SHIP)).toEqual([]);
  expect(github.threads[0]?.comments).toHaveLength(2);
});

test("a stand-down note is what keeps an approval from asking twice", async () => {
  const github = fakePullRequest();
  github.setCi("green");
  github.approve("head-1");

  const ready = classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes;
  expect(ready).toEqual([{ kind: "merge-ready", headSha: "head-1", retryNoted: false }]);

  // The merge is refused; the note records that this commit was tried.
  await postPullRequestNote({
    fetchPullRequestState: github.snapshot,
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    reason: "merge",
    headSha: "head-1",
    body: "I could not merge this pull request.",
  });
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([]);

  // Nothing asks for a second note: the wake that would have carried the merge
  // is gone, which is the whole of "post once".
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([]);
  expect(github.conversation).toHaveLength(1);

  // The approval is withdrawn, and a later revision is not merged on its
  // strength.
  github.dismiss();
  github.push("head-2");
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([]);

  // A fresh approval of the new commit is new work, note or no note.
  github.approve("head-2");
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([
    { kind: "merge-ready", headSha: "head-2", retryNoted: false },
  ]);
});

test("a red head is outstanding until the branch moves or jigs says it could not fix it", async () => {
  const github = fakePullRequest();
  github.setCi("red");
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toMatchObject([
    { kind: "ci-red" },
  ]);

  await postPullRequestNote({
    fetchPullRequestState: github.snapshot,
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    reason: "ci",
    headSha: "head-1",
    body: "I could not repair the failing checks.",
  });
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([]);
  // Another workflow's own budget is its own business: the note is scoped.
  expect(classifyPullRequestState(await github.snapshot(), REVIEW, APPROVAL).wakes).toMatchObject([
    { kind: "ci-red" },
  ]);

  // A push is the other way a red head retires, with nothing written down.
  github.push("head-2");
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toMatchObject([
    { kind: "ci-red", headSha: "head-2" },
  ]);
});

test("a merge refused while a check is still running is retried, not stood down", async () => {
  const github = fakePullRequest();
  github.setCi("green");
  github.approve("head-1");
  const ready = classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes;
  expect(ready).toEqual([{ kind: "merge-ready", headSha: "head-1", retryNoted: false }]);

  // The operator retitled the pull request, so the re-fetch inside the merge
  // step sees a requeued check and GitHub refuses. That is a state jigs waits
  // out, and the note it leaves says so.
  github.setMergeState("unstable");
  await postPullRequestNote({
    fetchPullRequestState: github.snapshot,
    commentOnPullRequest: github.comment,
    pr,
    scope: SHIP,
    reason: "merge-retry",
    headSha: "head-1",
    body: "I could not merge this pull request yet. I will try again.",
  });
  // Nothing to do while GitHub still reports it unmergeable.
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([]);

  // The check lands. The same approval, on the same commit, is merge-ready
  // again with no operator action — and the note is not repeated.
  github.setMergeState("clean");
  expect(classifyPullRequestState(await github.snapshot(), SHIP, APPROVAL).wakes).toEqual([
    { kind: "merge-ready", headSha: "head-1", retryNoted: true },
  ]);
  expect(github.conversation).toHaveLength(1);
});

test("a repeated note for the same head and reason posts once", async () => {
  const github = fakePullRequest();
  const note = (reason: "merge-retry" | "merge", headSha: string) =>
    postPullRequestNote({
      fetchPullRequestState: github.snapshot,
      commentOnPullRequest: github.comment,
      pr,
      scope: SHIP,
      reason,
      headSha,
      body: `I could not merge ${headSha} yet.`,
    });

  await note("merge-retry", "head-1");
  await note("merge-retry", "head-1");
  expect(github.conversation).toHaveLength(1);

  // Another reason, or another head, is another note.
  await note("merge", "head-1");
  await note("merge-retry", "head-2");
  expect(github.conversation).toHaveLength(3);
});
