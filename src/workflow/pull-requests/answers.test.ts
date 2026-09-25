import { expect, test, vi } from "vitest";
import type { CheckRun, PullRequestSnapshot, ReviewThread } from "../../providers/github.ts";
import { postPullRequestNote, postReviewAnswers, renderChecks } from "./answers.ts";
import { parseMarkers } from "./marker.ts";

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_RUN", workflowName: "ship" }),
}));

const AT = "2026-08-26T12:00:00Z";
const SCOPE = "ship/AGE-403";

const thread = (rootId: number, body: string): ReviewThread => ({
  rootId,
  path: "src/gate.ts",
  line: 12,
  comments: [
    {
      id: rootId,
      rootId,
      body,
      user: "reviewer",
      path: "src/gate.ts",
      line: 12,
      createdAt: AT,
      updatedAt: AT,
    },
  ],
});

const threads = [thread(900, "why not a set here?"), thread(910, "typo")];

// What the gate hands over for a top-level comment or a review summary: one
// comment, no file anchor.
const conversation = (rootId: number, body: string): ReviewThread => ({
  rootId,
  path: "",
  line: null,
  origin: "conversation",
  comments: [
    {
      id: rootId,
      rootId,
      body,
      user: "reviewer",
      path: "",
      line: null,
      createdAt: AT,
      updatedAt: AT,
    },
  ],
});

const failing: CheckRun[] = [{ name: "test", conclusion: "failure", url: "http://ci.test/1" }];

const pr = { owner: "acme", repo: "api", number: 41 };

function recorder(failOn: (body: string) => boolean = () => false) {
  const replies: Array<[number, string]> = [];
  const comments: string[] = [];
  return {
    replies,
    comments,
    replyToPullRequestReviewThread: async (_pr: typeof pr, rootId: number, body: string) => {
      replies.push([rootId, body]);
      if (failOn(body)) throw new Error("socket hang up");
      return { id: 7000 + replies.length };
    },
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
});

const sources = (body: string) => parseMarkers(body).map((marker) => marker.source);

test("a thread reply carries a marker for the comment it answers", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: { answers: [{ threadId: 900, body: "done" }], commitExplanation: null },
    threads,
  });

  expect(posted.comments).toEqual([]);
  const [reply] = posted.replies;
  expect(reply?.[0]).toBe(900);
  expect(reply?.[1].startsWith("done\n\n")).toBe(true);
  expect(parseMarkers(reply?.[1] ?? "")).toEqual([
    { scope: SCOPE, run: "wrun_RUN", kind: "reply", source: `900@${AT}` },
  ]);
});

test("an answer naming no thread answers the conversation, never an inline thread", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: { answers: [{ threadId: null, body: "addressed both" }], commitExplanation: null },
    threads: [...threads, conversation(5150, "one more thing")],
  });

  expect(posted.replies).toEqual([]);
  // An inline comment is answered in its own thread, where the reviewer reads
  // it, so a conversation comment never claims one.
  expect(sources(posted.comments[0] ?? "")).toEqual([`5150@${AT}`]);
});

test("an answer that claims nothing still carries a marker of its own", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: { answers: [{ threadId: null, body: "nothing to add" }], commitExplanation: null },
    threads,
  });

  // Unmarked, it would read as a reviewer's comment on the next wake.
  expect(parseMarkers(posted.comments[0] ?? "")).toEqual([
    { scope: SCOPE, run: "wrun_RUN", kind: "reply" },
  ]);
});

test("a synthetic conversation thread is answered on the conversation, not replied into", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: { answers: [{ threadId: 5150, body: "good catch" }], commitExplanation: null },
    threads: [...threads, conversation(5150, "one more thing")],
  });

  // Replying into it would 404: there is no review comment 5150 to hang off.
  expect(posted.replies).toEqual([]);
  expect(sources(posted.comments[0] ?? "")).toEqual([`5150@${AT}`]);
});

test("an answer naming a thread this wake never carried lands on the conversation", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: { answers: [{ threadId: 4242, body: "invented" }], commitExplanation: null },
    threads,
  });

  // Replying into a thread the wake did not carry 404s, and a 404 burns the
  // step's three retries.
  expect(posted.replies).toEqual([]);
  expect(posted.comments).toHaveLength(1);
});

test("a post that fails ends the wake without failing the run", async () => {
  const posted = recorder((body) => body.startsWith("first"));
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: {
      answers: [
        { threadId: 900, body: "first" },
        { threadId: 910, body: "second" },
      ],
      commitExplanation: null,
    },
    threads,
  });

  // The write may have landed, so nothing is retried here and nothing after it
  // is posted: the next wake reads the pull request and finishes what is left.
  expect(posted.replies.map(([rootId]) => rootId)).toEqual([900]);
  expect(posted.comments).toEqual([]);
});

test("an explanation that cannot be posted does not fail the run either", async () => {
  const posted = recorder((body) => body.startsWith("Changed"));
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: {
      answers: [{ threadId: 900, body: "fixed" }],
      commitExplanation: "Changed the lookup and ran tests.",
    },
    committedSha: "head-2",
    threads,
  });

  expect(posted.replies).toHaveLength(1);
  expect(posted.comments).toHaveLength(1);
});

test("a commit explanation names the commit it explains", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: {
      answers: [{ threadId: 900, body: "fixed" }],
      commitExplanation: "Changed the lookup and ran tests.",
    },
    committedSha: "head-2",
    threads,
  });

  expect(posted.replies).toHaveLength(1);
  expect(parseMarkers(posted.comments[0] ?? "")).toEqual([
    { scope: SCOPE, run: "wrun_RUN", kind: "completion", source: "head-2" },
  ]);
});

test("a missing commit explanation degrades to posting the answers", async () => {
  const posted = recorder();
  await postReviewAnswers({
    ...posted,
    pr,
    scope: SCOPE,
    answers: { answers: [{ threadId: 900, body: "fixed" }], commitExplanation: null },
    committedSha: "head-2",
    threads,
  });

  expect(posted.replies).toHaveLength(1);
  expect(posted.comments).toEqual([]);
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

test("a red build the provider named no check for still renders something", () => {
  expect(renderChecks([])).toContain("without naming a check");
  expect(renderChecks(failing)).toBe("- **test** — failure — http://ci.test/1");
  // A commit status need not link anywhere.
  expect(renderChecks([{ name: "test", conclusion: "failure", url: "" }])).toBe(
    "- **test** — failure",
  );
});
