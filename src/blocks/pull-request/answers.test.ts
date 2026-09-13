import { expect, test } from "vitest";
import type { CheckRun, ReviewThread } from "../../providers/github.ts";
import { postReviewAnswers, renderChecks } from "./answers.ts";

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
      createdAt: "2026-08-26T12:00:00Z",
    },
  ],
});

const threads = [thread(900, "why not a set here?"), thread(910, "typo")];

// What the gate now hands over for a top-level comment or a review summary:
// one comment, no file anchor.
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
      createdAt: "2026-08-26T12:00:00Z",
    },
  ],
});

const failing: CheckRun[] = [{ name: "test", conclusion: "failure", url: "http://ci.test/1" }];

const pr = { owner: "acme", repo: "api", number: 41 };

function recorder() {
  const replies: Array<[number, string]> = [];
  const comments: string[] = [];
  return {
    replies,
    comments,
    replyToPullRequestReviewThread: async (_pr: typeof pr, rootId: number, body: string) => {
      replies.push([rootId, body]);
      return { id: 7000 + replies.length };
    },
    commentOnPullRequest: async (_pr: typeof pr, body: string) => {
      comments.push(body);
      return { id: 8000 + comments.length };
    },
  };
}

test("the ids of the thread replies it posts come back for the gate cursor", async () => {
  const posted = recorder();
  const ack = await postReviewAnswers({
    replyToPullRequestReviewThread: posted.replyToPullRequestReviewThread,
    commentOnPullRequest: posted.commentOnPullRequest,
    pr,
    answers: { answers: [{ threadId: 900, body: "done" }] },
    threads,
  });

  expect(posted.replies).toEqual([[900, "done"]]);
  expect(posted.comments).toEqual([]);
  expect(ack).toEqual({ selfCommentIds: [7001], selfConversationCommentIds: [] });
});

test("an answer that lands on the conversation acks in the conversation id space", async () => {
  const posted = recorder();
  const ack = await postReviewAnswers({
    replyToPullRequestReviewThread: posted.replyToPullRequestReviewThread,
    commentOnPullRequest: posted.commentOnPullRequest,
    pr,
    answers: { answers: [{ threadId: null, body: "addressed all four" }] },
    threads,
  });

  expect(posted.comments).toEqual(["addressed all four"]);
  expect(posted.replies).toEqual([]);
  expect(ack).toEqual({ selfCommentIds: [], selfConversationCommentIds: [8001] });
});

test("a synthetic conversation thread is answered on the conversation, not replied into", async () => {
  const posted = recorder();
  const ack = await postReviewAnswers({
    replyToPullRequestReviewThread: posted.replyToPullRequestReviewThread,
    commentOnPullRequest: posted.commentOnPullRequest,
    pr,
    answers: { answers: [{ threadId: 5150, body: "good catch" }] },
    threads: [...threads, conversation(5150, "one more thing")],
  });

  // Replying into it would 404: there is no review comment 5150 to hang off.
  expect(posted.replies).toEqual([]);
  expect(posted.comments).toEqual(["good catch"]);
  expect(ack).toEqual({ selfCommentIds: [], selfConversationCommentIds: [8001] });
});

test("an answer naming a thread this wake never carried lands on the conversation", async () => {
  const posted = recorder();
  const ack = await postReviewAnswers({
    replyToPullRequestReviewThread: posted.replyToPullRequestReviewThread,
    commentOnPullRequest: posted.commentOnPullRequest,
    pr,
    answers: { answers: [{ threadId: 4242, body: "invented" }] },
    threads,
  });

  // Replying into a thread the wake did not carry 404s, and a 404 burns the
  // step's three retries.
  expect(posted.replies).toEqual([]);
  expect(posted.comments).toEqual(["invented"]);
  expect(ack).toEqual({ selfCommentIds: [], selfConversationCommentIds: [8001] });
});

test("a red build the provider named no check for still renders something", () => {
  expect(renderChecks([])).toContain("without naming a check");
  expect(renderChecks(failing)).toBe("- **test** — failure — http://ci.test/1");
  // A commit status need not link anywhere.
  expect(renderChecks([{ name: "test", conclusion: "failure", url: "" }])).toBe(
    "- **test** — failure",
  );
});
