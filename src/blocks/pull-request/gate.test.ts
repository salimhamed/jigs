import { beforeEach, expect, test, vi } from "vitest";
import type { PrSnapshot, ReviewThread } from "../../providers/github.ts";
import {
  classifyPrState,
  type GateCursor,
  type GateWake,
  prToken,
  pullRequestGate,
  tokenFromGithubPayload,
} from "./gate.ts";

// The gate reaches the SDK through this one hook, so a stand-in that counts
// awaits and hands back a resolver is enough to drive the loop.
const { createHook, hook } = vi.hoisted(() => ({
  createHook: vi.fn(),
  hook: {
    awaited: 0,
    disposed: 0,
    conflict: null as { runId: string } | null,
    wake: null as (() => void) | null,
  },
}));

vi.mock("workflow", () => ({ createHook }));

beforeEach(() => {
  hook.awaited = 0;
  hook.disposed = 0;
  hook.conflict = null;
  hook.wake = null;
  createHook.mockReset();
  createHook.mockImplementation(() => ({
    token: "github:pr:acme/app#7",
    getConflict: async () => hook.conflict,
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: (onfulfilled: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) => {
      hook.awaited += 1;
      return new Promise<unknown>((resolve) => {
        hook.wake = () => resolve(undefined);
      }).then(onfulfilled, onrejected);
    },
    dispose: () => {
      hook.disposed += 1;
    },
  }));
});

const empty: GateCursor = {
  seenReviewIds: [],
  seenCommentIds: [],
  selfCommentIds: [],
  lastRedSha: null,
};

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  merged: false,
  headSha: "head-1",
  viewer: "jigs-bot",
  reviews: [],
  reviewThreads: [],
  conversationComments: [],
  ci: "pending",
  failingChecks: [],
  ...overrides,
});

const review = (id: number, state: string, user = "reviewer") => ({
  id,
  state,
  body: state === "CHANGES_REQUESTED" ? "please fix" : "",
  user,
  submittedAt: "2026-08-26T12:00:00Z",
});

const thread = (rootId: number, authors: Array<[number, string]>): ReviewThread => ({
  rootId,
  path: "src/gate.ts",
  line: 12,
  comments: authors.map(([id, user]) => ({
    id,
    rootId,
    body: `comment ${id}`,
    user,
    path: "src/gate.ts",
    line: 12,
    createdAt: "2026-08-26T12:00:00Z",
  })),
});

const conversationComment = (
  id: number,
  user = "reviewer",
  updatedAt = "2026-08-26T12:00:00Z",
) => ({
  id,
  body: `top-level ${id}`,
  user,
  userType: "User",
  createdAt: "2026-08-26T12:00:00Z",
  updatedAt,
});

const pr = { owner: "acme", repo: "app", number: 7 };

const check = (name: string) => ({
  name,
  conclusion: "failure",
  url: "http://ci.test/1",
});

test("no change yields no wakes — the unsatisfied-wake core", () => {
  const result = classifyPrState(snapshot(), empty);
  expect(result.wakes).toEqual([]);
  expect(result.done).toBe(false);
});

test("an approval yields approved but no longer ends the gate", () => {
  const result = classifyPrState(snapshot({ reviews: [review(1, "APPROVED")] }), empty);
  expect(result.wakes).toEqual([
    {
      kind: "approved",
      reviewId: 1,
      reviewer: "reviewer",
      submittedAt: "2026-08-26T12:00:00Z",
    },
  ]);
  // Human-merges mode has to keep listening until the PR actually closes.
  expect(result.done).toBe(false);
});

test("changes requested since the cursor yields a wake but keeps the gate open", () => {
  const result = classifyPrState(snapshot({ reviews: [review(2, "CHANGES_REQUESTED")] }), empty);
  expect(result.wakes).toEqual([
    {
      kind: "changes-requested",
      reviewId: 2,
      reviewer: "reviewer",
      body: "please fix",
      submittedAt: "2026-08-26T12:00:00Z",
    },
  ]);
  expect(result.done).toBe(false);
});

test("a changes-requested review submitted with inline comments yields one wake carrying both", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const result = classifyPrState(
    snapshot({
      reviews: [review(2, "CHANGES_REQUESTED")],
      reviewThreads: threads,
    }),
    empty,
  );

  expect(result.wakes).toEqual([{ kind: "review-comments", threads, body: "please fix" }]);
});

test("an approval alongside inline comments is left alone", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const result = classifyPrState(
    snapshot({ reviews: [review(1, "APPROVED")], reviewThreads: threads }),
    empty,
  );

  expect(result.wakes.map((wake) => wake.kind)).toEqual(["approved", "review-comments"]);
});

test("already-seen reviews are not re-yielded", () => {
  const reviews = [review(2, "CHANGES_REQUESTED")];
  const first = classifyPrState(snapshot({ reviews }), empty);
  const second = classifyPrState(snapshot({ reviews }), first.cursor);
  expect(second.wakes).toEqual([]);
  expect(second.cursor.seenReviewIds).toEqual([2]);
});

test("a comment-only review with no body advances the cursor without a wake", () => {
  const result = classifyPrState(snapshot({ reviews: [review(3, "COMMENTED")] }), empty);
  expect(result.wakes).toEqual([]);
  expect(result.cursor.seenReviewIds).toEqual([3]);
});

// A factory sharing its operator's GitHub identity cannot submit an approving
// or changes-requesting review on its own pull request, so a COMMENTED body is
// how that reviewer sends work back.
test("a comment-only review with a body wakes the loop as a conversation thread", () => {
  const commented = { ...review(3, "COMMENTED"), body: "please rename this" };
  const result = classifyPrState(snapshot({ reviews: [commented] }), empty);

  expect(result.wakes).toEqual([
    {
      kind: "review-comments",
      threads: [
        {
          rootId: 3,
          path: "",
          line: null,
          origin: "conversation",
          comments: [
            {
              id: 3,
              rootId: 3,
              body: "please rename this",
              user: "reviewer",
              path: "",
              line: null,
              createdAt: "2026-08-26T12:00:00Z",
            },
          ],
        },
      ],
    },
  ]);
  const second = classifyPrState(snapshot({ reviews: [commented] }), result.cursor);
  expect(second.wakes).toEqual([]);
});

test("a conversation comment wakes the loop once, as a single-comment thread", () => {
  const comments = [conversationComment(5150)];
  const result = classifyPrState(snapshot({ conversationComments: comments }), empty);

  expect(result.wakes).toHaveLength(1);
  const [wake] = result.wakes;
  expect(wake).toMatchObject({ kind: "review-comments" });
  expect(wake?.kind === "review-comments" && wake.threads).toMatchObject([
    { rootId: 5150, origin: "conversation", path: "", line: null },
  ]);
  expect(result.cursor.seenConversationComments).toEqual(["5150@2026-08-26T12:00:00Z"]);

  const second = classifyPrState(snapshot({ conversationComments: comments }), result.cursor);
  expect(second.wakes).toEqual([]);
});

// Coverage reports and dependabot live on this surface too, and each would
// otherwise spend a revision round. The self guard stays exact-id: a human and
// jigs are both "User" here.
test("a bot's conversation comment never wakes the loop", () => {
  const bot = { ...conversationComment(5150, "codecov[bot]"), userType: "Bot" };
  const result = classifyPrState(snapshot({ conversationComments: [bot] }), empty);

  expect(result.wakes).toEqual([]);
  expect(result.skippedSelfThreads).toBe(0);
  expect(result.cursor.seenConversationComments).toEqual(["5150@2026-08-26T12:00:00Z"]);
});

test("an empty conversation comment wakes nobody, like a bodiless review", () => {
  const blank = { ...conversationComment(5150), body: "" };
  expect(classifyPrState(snapshot({ conversationComments: [blank] }), empty).wakes).toEqual([]);
});

test("a conversation comment jigs posted itself never wakes the loop", () => {
  const result = classifyPrState(
    snapshot({ viewer: "salim", conversationComments: [conversationComment(5150, "salim")] }),
    {
      ...empty,
      selfConversationCommentIds: [5150],
    },
  );

  expect(result.wakes).toEqual([]);
  expect(result.skippedSelfThreads).toBe(1);
});

// The id spaces are separate: GitHub numbers issue comments and review
// comments independently, so a self-acked thread reply must not silence a
// conversation comment that happens to share its number.
test("a thread reply id does not silence the conversation comment of the same number", () => {
  const result = classifyPrState(snapshot({ conversationComments: [conversationComment(901)] }), {
    ...empty,
    selfCommentIds: [901],
  });

  expect(result.wakes).toHaveLength(1);
});

test("an edited conversation comment wakes the loop again; jigs' own still does not", () => {
  const first = classifyPrState(
    snapshot({ conversationComments: [conversationComment(5150)] }),
    empty,
  );
  const edited = conversationComment(5150, "reviewer", "2026-08-26T13:00:00Z");
  const second = classifyPrState(snapshot({ conversationComments: [edited] }), first.cursor);

  expect(second.wakes).toHaveLength(1);
  expect(second.cursor.seenConversationComments).toEqual([
    "5150@2026-08-26T12:00:00Z",
    "5150@2026-08-26T13:00:00Z",
  ]);

  const ours = classifyPrState(snapshot({ conversationComments: [edited] }), {
    ...empty,
    selfConversationCommentIds: [5150],
  });
  expect(ours.wakes).toEqual([]);
});

test("inline threads and conversation comments arrive in one wake", () => {
  const inline = thread(900, [[900, "reviewer"]]);
  const result = classifyPrState(
    snapshot({
      reviewThreads: [inline],
      conversationComments: [conversationComment(5150)],
      reviews: [{ ...review(3, "COMMENTED"), body: "and the naming" }],
    }),
    empty,
  );

  expect(result.wakes).toHaveLength(1);
  const [wake] = result.wakes;
  expect(wake?.kind === "review-comments" && wake.threads.map((t) => t.rootId)).toEqual([
    900, 5150, 3,
  ]);
});

test("an unanswered thread since the cursor yields review-comments", () => {
  const threads = [thread(900, [[900, "reviewer"]]), thread(910, [[910, "reviewer"]])];
  const result = classifyPrState(snapshot({ reviewThreads: threads }), empty);

  expect(result.wakes).toEqual([{ kind: "review-comments", threads }]);
  expect(result.cursor.seenCommentIds).toEqual([900, 910]);
});

// The whole point of the self guard being id-based: on a factory running the
// operator's own token the viewer IS the reviewer, and filtering by author
// swallowed every human review comment.
test("a comment by the viewer's own login still yields review-comments", () => {
  const threads = [thread(900, [[900, "salim"]])];
  const result = classifyPrState(snapshot({ viewer: "salim", reviewThreads: threads }), empty);

  expect(result.wakes).toEqual([{ kind: "review-comments", threads }]);
});

test("a thread whose only new comment is our own acked reply yields nothing", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const first = classifyPrState(snapshot({ reviewThreads: threads }), empty);
  expect(first.wakes).toHaveLength(1);

  const answered = [
    thread(900, [
      [900, "reviewer"],
      [901, "salim"],
    ]),
  ];
  const second = classifyPrState(snapshot({ viewer: "salim", reviewThreads: answered }), {
    ...first.cursor,
    selfCommentIds: [901],
  });

  expect(second.wakes).toEqual([]);
  expect(second.skippedSelfThreads).toBe(1);
  expect(second.cursor.seenCommentIds).toEqual([900, 901]);
  expect(second.cursor.selfCommentIds).toEqual([901]);
});

test("a human's follow-up on a thread we answered re-opens it", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const first = classifyPrState(snapshot({ reviewThreads: threads }), empty);
  const answered = [
    thread(900, [
      [900, "reviewer"],
      [901, "salim"],
    ]),
  ];
  const second = classifyPrState(snapshot({ viewer: "salim", reviewThreads: answered }), {
    ...first.cursor,
    selfCommentIds: [901],
  });

  // The operator, on their own token: same login as our reply above.
  const followUp = [
    thread(900, [
      [900, "reviewer"],
      [901, "salim"],
      [902, "salim"],
    ]),
  ];
  const third = classifyPrState(
    snapshot({ viewer: "salim", reviewThreads: followUp }),
    second.cursor,
  );
  expect(third.wakes).toEqual([{ kind: "review-comments", threads: followUp }]);
  expect(third.skippedSelfThreads).toBe(0);
});

test("an unacked reply of ours is a wake — the guard is ids, not identity", () => {
  const threads = [
    thread(900, [
      [900, "reviewer"],
      [901, "jigs-bot"],
    ]),
  ];
  const result = classifyPrState(snapshot({ reviewThreads: threads }), empty);

  expect(result.wakes).toEqual([{ kind: "review-comments", threads }]);
  expect(result.cursor.seenCommentIds).toEqual([900, 901]);
});

test("already-seen comments are not re-yielded", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const first = classifyPrState(snapshot({ reviewThreads: threads }), empty);
  const second = classifyPrState(snapshot({ reviewThreads: threads }), first.cursor);
  expect(second.wakes).toEqual([]);
  expect(second.cursor.seenCommentIds).toEqual([900]);
});

// The contract followPullRequest leans on now that it keeps no comment set of
// its own: every wake carries at least one piece of feedback no earlier wake
// carried, and jigs' own acked comments carry none. Inline threads still
// arrive with their full history, so the guarantee is about what is *new* in a
// wake, not about a comment never appearing twice.
test("every wake carries feedback no earlier wake did, and jigs' own acked comments carry none", () => {
  const inline = (comments: Array<[number, string]>) => thread(900, comments);
  const commented = { ...review(3, "COMMENTED"), body: "and the naming" };
  const rounds: Array<[string, Partial<PrSnapshot>]> = [
    ["an inline comment", { reviewThreads: [inline([[900, "salim"]])] }],
    [
      "a conversation comment",
      {
        reviewThreads: [inline([[900, "salim"]])],
        conversationComments: [conversationComment(5150)],
      },
    ],
    [
      "a COMMENTED review body",
      {
        reviewThreads: [inline([[900, "salim"]])],
        conversationComments: [conversationComment(5150)],
        reviews: [commented],
      },
    ],
    [
      "an edit of that conversation comment",
      {
        reviewThreads: [inline([[900, "salim"]])],
        conversationComments: [
          {
            ...conversationComment(5150, "reviewer", "2026-08-26T13:00:00Z"),
            body: "on reflection",
          },
        ],
        reviews: [commented],
      },
    ],
    [
      "jigs' own acked answers",
      {
        reviewThreads: [
          inline([
            [900, "salim"],
            [901, "salim"],
          ]),
        ],
        conversationComments: [
          {
            ...conversationComment(5150, "reviewer", "2026-08-26T13:00:00Z"),
            body: "on reflection",
          },
          conversationComment(8001, "salim"),
        ],
        reviews: [commented],
      },
    ],
    [
      "a human follow-up on the thread jigs answered",
      {
        reviewThreads: [
          inline([
            [900, "salim"],
            [901, "salim"],
            [902, "salim"],
          ]),
        ],
        conversationComments: [
          {
            ...conversationComment(5150, "reviewer", "2026-08-26T13:00:00Z"),
            body: "on reflection",
          },
          conversationComment(8001, "salim"),
        ],
        reviews: [commented],
      },
    ],
  ];

  // What the consumer can observe on a wake. The conversation comment's
  // `updatedAt` is not on it, which is exactly why an id alone cannot stand in
  // for a version downstream — the gate's cursor is the only authority.
  const carried = (wake: GateWake): string[] =>
    wake.kind !== "review-comments"
      ? []
      : wake.threads.flatMap((t) =>
          t.comments.map((c) => `${t.origin ?? "inline"}:${c.id}:${c.body}`),
        );

  // The ids jigs posted in round five, acked as the consumer would ack them.
  let cursor: GateCursor = { ...empty, selfCommentIds: [901], selfConversationCommentIds: [8001] };
  const everCarried = new Set<string>();
  const woke: string[] = [];
  for (const [what, overrides] of rounds) {
    const round = classifyPrState(snapshot({ viewer: "salim", ...overrides }), cursor);
    cursor = round.cursor;
    for (const wake of round.wakes) {
      woke.push(what);
      const fresh = carried(wake).filter((item) => !everCarried.has(item));
      // The dead-short-circuit property: a consumer that re-deduped by id
      // could only ever drop a wake, never save one.
      expect(fresh.length, `${what} carried nothing new`).toBeGreaterThan(0);
      for (const item of carried(wake)) everCarried.add(item);
    }
  }

  expect(woke).toEqual([
    "an inline comment",
    "a conversation comment",
    "a COMMENTED review body",
    "an edit of that conversation comment",
    "a human follow-up on the thread jigs answered",
  ]);
  // Each distinct piece of feedback triggered exactly one wake, and neither of
  // jigs' own two comments triggered any.
  expect(woke).toHaveLength(5);
});

test("a new red head yields ci-red naming the failing checks and the reviewer to escalate to", () => {
  const result = classifyPrState(
    snapshot({
      ci: "red",
      failingChecks: [check("test")],
      reviews: [review(1, "COMMENTED"), review(2, "COMMENTED", "salim")],
    }),
    empty,
  );
  expect(result.wakes).toEqual([
    {
      kind: "ci-red",
      headSha: "head-1",
      failing: [check("test")],
      mentionLogin: "salim",
    },
  ]);
  expect(result.cursor.lastRedSha).toBe("head-1");
});

test("the same red head does not re-yield, but a new head does", () => {
  const red = snapshot({ ci: "red", failingChecks: [check("test")] });
  const first = classifyPrState(red, empty);
  const second = classifyPrState(red, first.cursor);
  expect(second.wakes).toEqual([]);

  const pushed = classifyPrState(
    snapshot({ ci: "red", headSha: "head-2", failingChecks: [check("test")] }),
    second.cursor,
  );
  expect(pushed.wakes).toEqual([expect.objectContaining({ kind: "ci-red", headSha: "head-2" })]);
});

test("a recovery to green yields ci-green, and green from nowhere yields nothing", () => {
  const fresh = classifyPrState(snapshot({ ci: "green" }), empty);
  expect(fresh.wakes).toEqual([]);

  const red = classifyPrState(snapshot({ ci: "red", failingChecks: [check("test")] }), empty);
  const recovered = classifyPrState(snapshot({ ci: "green", headSha: "head-2" }), red.cursor);
  expect(recovered.wakes).toEqual([{ kind: "ci-green", headSha: "head-2" }]);
  expect(recovered.cursor.lastRedSha).toBeNull();
});

test("pending yields nothing and leaves the cursor's CI state alone", () => {
  const red = classifyPrState(snapshot({ ci: "red", failingChecks: [check("test")] }), empty);
  const pending = classifyPrState(snapshot({ ci: "pending" }), red.cursor);
  expect(pending.wakes).toEqual([]);
  expect(pending.cursor.lastRedSha).toBe(red.cursor.lastRedSha);
});

test("a closed PR yields closed with the merged flag and finishes the gate", () => {
  for (const merged of [true, false]) {
    const result = classifyPrState(snapshot({ state: "closed", merged }), empty);
    expect(result.wakes).toEqual([{ kind: "closed", merged }]);
    expect(result.done).toBe(true);
  }
});

test("the gate classifies a first snapshot before it ever awaits the hook", async () => {
  const fetchState = vi.fn(async () => snapshot({ state: "closed", merged: true }));
  const gate = pullRequestGate(pr, fetchState);

  expect(await gate.next()).toEqual({
    done: false,
    value: { kind: "closed", merged: true },
  });
  expect(await gate.next()).toEqual({ done: true, value: undefined });
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("an ack handed back between wakes reaches the next round's cursor", async () => {
  const asked = thread(900, [[900, "reviewer"]]);
  const answered = thread(900, [
    [900, "reviewer"],
    [901, "salim"],
  ]);
  const states = [
    snapshot({ viewer: "salim", reviewThreads: [asked] }),
    snapshot({ viewer: "salim", reviewThreads: [answered] }),
    snapshot({
      viewer: "salim",
      reviewThreads: [answered],
      state: "closed",
      merged: true,
    }),
  ];
  let round = 0;
  const fetchState = vi.fn(async () => {
    const staged = states[round++];
    if (staged === undefined) throw new Error("the gate fetched a fourth time");
    return staged;
  });
  const gate = pullRequestGate(pr, fetchState);

  expect(await gate.next()).toEqual({
    done: false,
    value: { kind: "review-comments", threads: [asked] },
  });

  const closed = gate.next({ selfCommentIds: [901] });
  await vi.waitFor(() => expect(hook.awaited).toBe(1));
  hook.wake?.();
  // Round two sees nothing but the acked reply, so it wakes no one and parks.
  await vi.waitFor(() => expect(hook.awaited).toBe(2));
  hook.wake?.();

  expect(await closed).toEqual({
    done: false,
    value: { kind: "closed", merged: true },
  });
  expect(fetchState).toHaveBeenCalledTimes(3);
  expect(hook.disposed).toBe(0);
  await gate.next();
  expect(hook.disposed).toBe(1);
});

test("an ack for a conversation answer keeps that comment from waking the loop", async () => {
  const asked = conversationComment(5150);
  const answered = { ...conversationComment(8001, "salim"), body: "good catch" };
  const states = [
    snapshot({ viewer: "salim", conversationComments: [asked] }),
    snapshot({ viewer: "salim", conversationComments: [asked, answered] }),
    snapshot({
      viewer: "salim",
      conversationComments: [asked, answered],
      state: "closed",
      merged: true,
    }),
  ];
  let round = 0;
  const fetchState = vi.fn(async () => {
    const staged = states[round++];
    if (staged === undefined) throw new Error("the gate fetched a fourth time");
    return staged;
  });
  const gate = pullRequestGate(pr, fetchState);

  expect((await gate.next()).value).toMatchObject({ kind: "review-comments" });

  const closed = gate.next({ selfCommentIds: [], selfConversationCommentIds: [8001] });
  await vi.waitFor(() => expect(hook.awaited).toBe(1));
  hook.wake?.();
  // Round two sees only jigs' own answer, so it wakes no one and parks.
  await vi.waitFor(() => expect(hook.awaited).toBe(2));
  hook.wake?.();

  expect(await closed).toEqual({
    done: false,
    value: { kind: "closed", merged: true },
  });
});

test("a pr another run already holds is a claim conflict, never fetched", async () => {
  hook.conflict = { runId: "wrun_OWNER" };
  const fetchState = vi.fn(async () => snapshot());

  await expect(pullRequestGate(pr, fetchState).next()).rejects.toThrow(
    "is already claimed by run wrun_OWNER",
  );
  expect(fetchState).not.toHaveBeenCalled();
  expect(hook.disposed).toBe(1);
});

test("pr token, including dots and dashes in names", () => {
  expect(prToken({ owner: "acme-inc", repo: "api.v2", number: 41 })).toBe(
    "github:pr:acme-inc/api.v2#41",
  );
});

test("a pull_request_review payload reconstructs the exact pr token", () => {
  const payload = {
    action: "submitted",
    review: { id: 7, state: "approved" },
    pull_request: { number: 41, title: "Add ingress" },
    repository: {
      name: "api.v2",
      full_name: "acme-inc/api.v2",
      owner: { login: "acme-inc" },
    },
  };
  expect(tokenFromGithubPayload(payload)).toBe(
    prToken({ owner: "acme-inc", repo: "api.v2", number: 41 }),
  );
});

test("an issue_comment on a pull request routes to the pr token", () => {
  const repository = { name: "api", owner: { login: "acme" } };
  expect(
    tokenFromGithubPayload({
      action: "created",
      issue: { number: 41, pull_request: { url: "https://api/pulls/41" } },
      comment: { id: 5, body: "one more thing" },
      repository,
    }),
  ).toBe(prToken({ owner: "acme", repo: "api", number: 41 }));

  // The same event shape on a plain issue names no pull request.
  expect(
    tokenFromGithubPayload({
      action: "created",
      issue: { number: 41 },
      comment: { id: 5, body: "one more thing" },
      repository,
    }),
  ).toBe(null);
});

test("check_suite and check_run route through their pull_requests list", () => {
  const repository = { name: "api", owner: { login: "acme" } };
  const expected = prToken({ owner: "acme", repo: "api", number: 41 });
  expect(
    tokenFromGithubPayload({
      action: "completed",
      check_suite: {
        id: 9,
        conclusion: "failure",
        pull_requests: [{ number: 41 }],
      },
      repository,
    }),
  ).toBe(expected);
  expect(
    tokenFromGithubPayload({
      action: "completed",
      check_run: {
        id: 9,
        conclusion: "failure",
        pull_requests: [{ number: 41 }],
      },
      repository,
    }),
  ).toBe(expected);
});

test("a check_suite belonging to no pull request is unroutable", () => {
  expect(
    tokenFromGithubPayload({
      action: "completed",
      check_suite: { id: 9, conclusion: "success", pull_requests: [] },
      repository: { name: "api", owner: { login: "acme" } },
    }),
  ).toBe(null);
});

test("a github ping payload is unroutable", () => {
  expect(
    tokenFromGithubPayload({
      zen: "Keep it logically awesome.",
      hook_id: 1,
      repository: { name: "api", owner: { login: "acme" } },
    }),
  ).toBe(null);
  expect(tokenFromGithubPayload(null)).toBe(null);
  expect(tokenFromGithubPayload("pull_request")).toBe(null);
  expect(tokenFromGithubPayload({ pull_request: { number: "41" }, repository: {} })).toBe(null);
});
