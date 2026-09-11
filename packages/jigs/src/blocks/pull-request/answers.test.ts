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

const failing: CheckRun[] = [
  { name: "test", conclusion: "failure", url: "http://ci.test/1" },
];

const pr = { owner: "acme", repo: "api", number: 41 };

function recorder() {
  const replies: Array<[number, string]> = [];
  const comments: string[] = [];
  return {
    replies,
    comments,
    replyInThread: async (_pr: typeof pr, rootId: number, body: string) => {
      replies.push([rootId, body]);
      return { id: 7000 + replies.length };
    },
    commentOnPr: async (_pr: typeof pr, body: string) => {
      comments.push(body);
    },
  };
}

test("the ids of the thread replies it posts come back for the gate cursor", async () => {
  const posted = recorder();
  const ids = await postReviewAnswers({
    replyInThread: posted.replyInThread,
    commentOnPr: posted.commentOnPr,
    pr,
    answers: { answers: [{ threadId: 900, body: "done" }] },
    threads,
  });

  expect(posted.replies).toEqual([[900, "done"]]);
  expect(posted.comments).toEqual([]);
  expect(ids).toEqual([7001]);
});

test("an answer that lands on the conversation acks nothing", async () => {
  const posted = recorder();
  const ids = await postReviewAnswers({
    replyInThread: posted.replyInThread,
    commentOnPr: posted.commentOnPr,
    pr,
    answers: { answers: [{ threadId: null, body: "addressed all four" }] },
    threads,
  });

  expect(posted.comments).toEqual(["addressed all four"]);
  expect(posted.replies).toEqual([]);
  expect(ids).toEqual([]);
});

test("an answer naming a thread this wake never carried lands on the conversation", async () => {
  const posted = recorder();
  const ids = await postReviewAnswers({
    replyInThread: posted.replyInThread,
    commentOnPr: posted.commentOnPr,
    pr,
    answers: { answers: [{ threadId: 4242, body: "invented" }] },
    threads,
  });

  // Replying into a thread the wake did not carry 404s, and a 404 burns the
  // step's three retries.
  expect(posted.replies).toEqual([]);
  expect(posted.comments).toEqual(["invented"]);
  expect(ids).toEqual([]);
});

test("a red build the provider named no check for still renders something", () => {
  expect(renderChecks([])).toContain("without naming a check");
  expect(renderChecks(failing)).toBe("- **test** — failure — http://ci.test/1");
  // A commit status need not link anywhere.
  expect(renderChecks([{ name: "test", conclusion: "failure", url: "" }])).toBe(
    "- **test** — failure",
  );
});
