import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PullRequestSnapshot, ReviewThread } from "../../providers/github.ts";
import {
  classifyPullRequestState,
  type PullRequestWake,
  pullRequestGate,
  pullRequestToken,
  tokenFromGitHubPayload,
} from "./gate.ts";
import { type MarkerKind, markBody, type StatusReason } from "./marker.ts";
import type { ApprovalSignal } from "./policy.ts";

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

const SCOPE = "ship/AGE-403";
const AT = "2026-08-26T12:00:00Z";

const APPROVAL: ApprovalSignal = { kind: "review" };

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
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
  ci: "pending",
  failingChecks: [],
  ...overrides,
});

const review = (id: number, state: string, user = "reviewer", body?: string) => ({
  id,
  state,
  body: body ?? (state === "CHANGES_REQUESTED" ? "please fix" : ""),
  user,
  submittedAt: AT,
});

const approval = (id: number, commitSha = "head-1", user = "reviewer") => ({
  ...review(id, "APPROVED", user),
  commitSha,
});

const comment = (id: number, user: string, body?: string, updatedAt = AT) => ({
  id,
  rootId: id,
  body: body ?? `comment ${id}`,
  user,
  path: "src/gate.ts",
  line: 12,
  createdAt: AT,
  updatedAt,
});

const thread = (rootId: number, comments: ReviewThread["comments"]): ReviewThread => ({
  rootId,
  path: "src/gate.ts",
  line: 12,
  comments,
});

const conversationComment = (id: number, user = "reviewer", body?: string, updatedAt = AT) => ({
  id,
  body: body ?? `top-level ${id}`,
  user,
  userType: "User",
  createdAt: AT,
  updatedAt,
});

// What jigs posts: prose plus the marker naming what it answers.
const answering = (source: string, kind: MarkerKind = "reply", scope = SCOPE) =>
  markBody("done", [{ scope, run: "wrun_TEST", kind, source }]);

// A note about a commit, which says which kind of note it is.
const standingDown = (source: string, reason: StatusReason, scope = SCOPE) =>
  markBody("standing down", [{ scope, run: "wrun_TEST", kind: "status", reason, source }]);

const pr = { owner: "acme", repo: "app", number: 7 };

// Only read when a gate is given a worktree.
const readLocalHead = vi.fn(async () => ({ headSha: "head-1" }));
const branchContains = vi.fn(async () => false);

const check = (name: string) => ({ name, conclusion: "failure", url: "http://ci.test/1" });

const wakesOf = (state: PullRequestSnapshot, scope = SCOPE): PullRequestWake[] =>
  classifyPullRequestState(state, scope, APPROVAL).wakes;

test("a pull request with nothing outstanding yields no wakes", () => {
  const state = classifyPullRequestState(snapshot(), SCOPE, APPROVAL);
  expect(state.wakes).toEqual([]);
  expect(state.done).toBe(false);
});

test("an inline thread with an unanswered human comment yields review-comments", () => {
  const asked = thread(900, [comment(900, "reviewer")]);
  expect(wakesOf(snapshot({ reviewThreads: [asked] }))).toEqual([
    { kind: "review-comments", threads: [asked] },
  ]);
});

test("a marked answer to that comment retires the thread", () => {
  const answered = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering("900@2026-08-26T12:00:00Z")),
  ]);
  expect(wakesOf(snapshot({ reviewThreads: [answered] }))).toEqual([]);
});

test("a human follow-up on an answered thread re-opens it", () => {
  const followed = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering("900@2026-08-26T12:00:00Z")),
    comment(902, "reviewer", "still wrong"),
  ]);
  expect(wakesOf(snapshot({ reviewThreads: [followed] }))).toHaveLength(1);
});

test("an edited comment is unanswered again — the answer named the old text", () => {
  const edited = thread(900, [
    comment(900, "reviewer", "comment 900", "2026-08-26T13:00:00Z"),
    comment(901, "salim", answering("900@2026-08-26T12:00:00Z")),
  ]);
  expect(wakesOf(snapshot({ reviewThreads: [edited] }))).toHaveLength(1);
});

test("another scope's marker is jigs' own comment, but answers nothing of ours", () => {
  const other = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering("900@2026-08-26T12:00:00Z", "reply", "review/outstanding")),
  ]);
  const state = classifyPullRequestState(snapshot({ reviewThreads: [other] }), SCOPE, APPROVAL);
  expect(state.wakes).toHaveLength(1);
  // Its own comment is never read back as feedback, whoever wrote it.
  expect(state.wakes[0]).toEqual({ kind: "review-comments", threads: [other] });
  expect(state.ownComments).toBe(1);
});

test("a completion marker answers its source as a reply does", () => {
  const completed = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering("900@2026-08-26T12:00:00Z", "completion")),
  ]);
  expect(wakesOf(snapshot({ reviewThreads: [completed] }))).toEqual([]);
});

test("a conversation comment wakes the loop as a single-comment thread", () => {
  const wakes = wakesOf(snapshot({ conversationComments: [conversationComment(500)] }));
  expect(wakes).toEqual([
    {
      kind: "review-comments",
      threads: [
        {
          rootId: 500,
          path: "",
          line: null,
          origin: "conversation",
          comments: [
            {
              id: 500,
              rootId: 500,
              body: "top-level 500",
              user: "reviewer",
              path: "",
              line: null,
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      ],
    },
  ]);
});

test("a bot's conversation comment, and an empty one, wake nobody", () => {
  expect(
    wakesOf(
      snapshot({
        conversationComments: [
          { ...conversationComment(501), userType: "Bot" },
          { ...conversationComment(502), body: "" },
        ],
      }),
    ),
  ).toEqual([]);
});

test("a conversation comment jigs posted is never feedback", () => {
  const state = classifyPullRequestState(
    snapshot({
      conversationComments: [conversationComment(503, "salim", standingDown("head-9", "ci"))],
    }),
    SCOPE,
    APPROVAL,
  );
  expect(state.wakes).toEqual([]);
  expect(state.ownComments).toBe(1);
});

test("a comment-only review's body is feedback; a bodiless one is not", () => {
  const wakes = wakesOf(
    snapshot({
      reviews: [review(1, "COMMENTED", "reviewer", "one thought"), review(2, "COMMENTED")],
    }),
  );
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    kind: "review-comments",
    threads: [{ rootId: 1, origin: "conversation" }],
  });
});

test("a changes-requested review arrives with its summary and its inline threads in one wake", () => {
  const asked = thread(900, [comment(900, "reviewer")]);
  const wakes = wakesOf(
    snapshot({ reviews: [review(4, "CHANGES_REQUESTED")], reviewThreads: [asked] }),
  );
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ kind: "review-comments", body: "please fix" });
  expect((wakes[0] as { threads: ReviewThread[] }).threads.map((t) => t.rootId)).toEqual([900, 4]);
});

test("an answered review summary does not come back", () => {
  const wakes = wakesOf(
    snapshot({
      reviews: [review(4, "CHANGES_REQUESTED")],
      conversationComments: [conversationComment(505, "salim", answering(`4@${AT}`))],
    }),
  );
  expect(wakes).toEqual([]);
});

test("a red head yields ci-red naming the failing checks and who to escalate to", () => {
  const wakes = wakesOf(
    snapshot({
      ci: "red",
      failingChecks: [check("build")],
      reviews: [review(1, "COMMENTED", "person", "looks fine")],
      conversationComments: [conversationComment(506, "salim", answering(`1@${AT}`))],
    }),
  );
  expect(wakes).toEqual([
    {
      kind: "ci-red",
      headSha: "head-1",
      failing: [check("build")],
      mentionLogin: "person",
    },
  ]);
});

test("a marked could-not-repair note settles that red head", () => {
  const state = snapshot({
    ci: "red",
    failingChecks: [check("build")],
    conversationComments: [conversationComment(507, "salim", standingDown("head-1", "ci"))],
  });
  expect(wakesOf(state)).toEqual([]);
  // A note about a merge on the same commit is not a note about its checks.
  expect(
    wakesOf({
      ...state,
      conversationComments: [conversationComment(507, "salim", standingDown("head-1", "merge"))],
    }),
  ).toHaveLength(1);
  // A different head is a different failure, and outstanding again.
  expect(wakesOf({ ...state, headSha: "head-2" })).toHaveLength(1);
});

test("green and pending CI yield nothing on their own", () => {
  expect(wakesOf(snapshot({ ci: "green" }))).toEqual([]);
  expect(wakesOf(snapshot({ ci: "pending" }))).toEqual([]);
});

test("a failed commit status wakes ci-red and its successful recovery clears it", () => {
  const failed = snapshot({
    ci: "red",
    failingChecks: [check("AWS CodeBuild us-west-2")],
  });
  expect(classifyPullRequestState(failed, SCOPE, APPROVAL)).toMatchObject({
    wakes: [{ kind: "ci-red", headSha: "head-1" }],
    done: false,
  });

  // The next status wake re-fetches the same head. Once CodeBuild reports
  // success the snapshot is ci-green and the old red work is no longer due.
  const recovered = { ...failed, ci: "green" as const, failingChecks: [] };
  expect(recovered.ci).toBe("green");
  expect(classifyPullRequestState(recovered, SCOPE, APPROVAL)).toMatchObject({
    wakes: [],
    done: false,
  });
});

test("green plus an approval of the current head is merge-ready", () => {
  expect(wakesOf(snapshot({ ci: "green", reviews: [approval(1)] }))).toEqual([
    { kind: "merge-ready", headSha: "head-1", retryNoted: false },
  ]);
});

test("merge-ready waits behind outstanding feedback", () => {
  const wakes = wakesOf(
    snapshot({
      ci: "green",
      reviews: [approval(1)],
      conversationComments: [conversationComment(508)],
    }),
  );
  expect(wakes.map((wake) => wake.kind)).toEqual(["review-comments"]);
});

test("a dismissed approval takes merge-ready away", () => {
  const dismissed = { ...approval(1), state: "DISMISSED" };
  expect(wakesOf(snapshot({ ci: "green", reviews: [dismissed] }))).toEqual([]);
});

test("a marked stand-down settles merge-ready for that head", () => {
  const state = snapshot({
    ci: "green",
    reviews: [approval(1)],
    conversationComments: [conversationComment(509, "salim", standingDown("head-1", "merge"))],
  });
  expect(wakesOf(state)).toEqual([]);
  // And a CI note on the same commit does not stand the merge down.
  expect(
    wakesOf({
      ...state,
      conversationComments: [conversationComment(509, "salim", standingDown("head-1", "ci"))],
    }),
  ).toEqual([{ kind: "merge-ready", headSha: "head-1", retryNoted: false }]);
});

test("a human quoting jigs' reply is a human, and is answered again", () => {
  // What GitHub's "Quote reply" produces: the whole body, marker included,
  // prefixed line by line.
  const quote = (body: string) =>
    body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  const quoted = [quote(answering(`900@${AT}`)), "", "What about the caller?"].join("\n");
  const followed = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering(`900@${AT}`)),
    comment(902, "reviewer", quoted),
  ]);
  const state = classifyPullRequestState(snapshot({ reviewThreads: [followed] }), SCOPE, APPROVAL);
  expect(state.wakes).toHaveLength(1);
  // Only the real reply counts as jigs' own; the quotation of it does not.
  expect(state.ownComments).toBe(1);
});

test("the identical snapshot classifies identically, every time", () => {
  const state = snapshot({
    ci: "red",
    failingChecks: [check("build")],
    reviewThreads: [thread(900, [comment(900, "reviewer")])],
  });
  expect(wakesOf(state)).toEqual(wakesOf(state));
  expect(wakesOf(state)).toHaveLength(2);
});

test("a closed PR yields closed with the merged flag and finishes the gate", () => {
  for (const merged of [true, false]) {
    const state = classifyPullRequestState(snapshot({ state: "closed", merged }), SCOPE, APPROVAL);
    expect(state.wakes).toEqual([{ kind: "closed", merged }]);
    expect(state.done).toBe(true);
  }
});

test("the gate classifies a first snapshot before it ever awaits the hook", async () => {
  const fetchState = vi.fn(async () => snapshot({ state: "closed", merged: true }));
  const gate = pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  );

  expect(await gate.next()).toEqual({
    done: false,
    value: { kind: "closed", merged: true },
  });
  expect(await gate.next()).toEqual({ done: true, value: undefined });
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("a second round re-reads the pull request and re-classifies it", async () => {
  const asked = thread(900, [comment(900, "reviewer")]);
  const answered = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering(`900@${AT}`)),
  ]);
  const states = [snapshot({ reviewThreads: [asked] }), snapshot({ reviewThreads: [answered] })];
  // The generator stays suspended on the hook when the test ends; nothing is
  // waiting on it.
  const fetchState = vi.fn(async () => states.shift() ?? snapshot());
  const gate = pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  );

  expect((await gate.next()).value).toMatchObject({ kind: "review-comments" });
  const next = gate.next();
  await Promise.resolve();
  hook.wake?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The answer is on the pull request now, so the same thread owes nothing and
  // the gate suspends again rather than yielding.
  expect(await Promise.race([next, Promise.resolve("suspended")])).toBe("suspended");
  expect(fetchState).toHaveBeenCalledTimes(2);
  expect(hook.awaited).toBe(2);
});

test("a wake whose head the branch moved past is not yielded", async () => {
  const asked = thread(900, [comment(900, "reviewer")]);
  const answered = thread(900, [
    comment(900, "reviewer"),
    comment(901, "salim", answering(`900@${AT}`)),
  ]);
  const red = { ci: "red" as const, failingChecks: [check("test")] };
  const states = [
    snapshot({ ...red, reviewThreads: [asked] }),
    // The consumer answered the thread and pushed before asking for the next wake.
    snapshot({ headSha: "head-2", reviewThreads: [answered] }),
  ];
  const fetchState = vi.fn(async () => states.shift() ?? snapshot({ headSha: "head-2" }));
  const gate = pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  );

  expect((await gate.next()).value).toMatchObject({ kind: "review-comments" });
  const next = gate.next();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The red build was on head-1; the new head owes nothing, so the gate
  // suspends instead of delivering it.
  expect(await Promise.race([next, Promise.resolve("suspended")])).toBe("suspended");
  expect(fetchState).toHaveBeenCalledTimes(2);
  expect(hook.awaited).toBe(1);
});

test("a later wake in the same round is yielded while the head stays put", async () => {
  const asked = thread(900, [comment(900, "reviewer")]);
  const fetchState = vi.fn(async () =>
    snapshot({ ci: "red", failingChecks: [check("test")], reviewThreads: [asked] }),
  );
  const gate = pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  );

  expect((await gate.next()).value).toMatchObject({ kind: "review-comments" });
  expect((await gate.next()).value).toMatchObject({ kind: "ci-red", headSha: "head-1" });
  expect(fetchState).toHaveBeenCalledTimes(2);
  expect(hook.awaited).toBe(0);
});

describe("with a worktree", () => {
  const worktree = {
    binding: "app",
    path: "/work",
    branch: "feature",
    defaultBranch: "main",
    baseSha: "base",
  };
  const red = snapshot({ ci: "red", failingChecks: [check("test")] });

  // The local head, and which commits the local branch contains.
  const gateOver = (localHead: string, contains: string[]) => {
    const steps = {
      fetchState: vi.fn(async () => red),
      readLocalHead: vi.fn(async () => ({ headSha: localHead })),
      branchContains: vi.fn(async (_path: string, sha: string) => contains.includes(sha)),
    };
    const gate = pullRequestGate(pr, steps, { scope: SCOPE, approval: APPROVAL, worktree });
    return { gate, steps };
  };

  test("a wake for a head the run has moved past is dropped", async () => {
    // The run pushed head-2 on top of head-1; GitHub still reports head-1 red.
    const { gate, steps } = gateOver("head-2", ["head-1", "head-2"]);
    const next = gate.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await Promise.race([next, Promise.resolve("suspended")])).toBe("suspended");
    expect(steps.readLocalHead).toHaveBeenCalledExactlyOnceWith(worktree);
    expect(steps.branchContains).toHaveBeenCalledExactlyOnceWith("/work", "head-1");
    expect(hook.awaited).toBe(1);
  });

  test("a wake for a head someone else pushed is delivered", async () => {
    // head-1 is not in the worktree: a human pushed it.
    const { gate } = gateOver("head-0", ["head-0"]);
    expect((await gate.next()).value).toMatchObject({ kind: "ci-red", headSha: "head-1" });
  });

  test("a wake for the local head is delivered", async () => {
    const { gate, steps } = gateOver("head-1", ["head-1"]);
    expect((await gate.next()).value).toMatchObject({ kind: "ci-red", headSha: "head-1" });
    expect(steps.branchContains).not.toHaveBeenCalled();
  });
});

test("without a worktree the local head is never read", async () => {
  readLocalHead.mockClear();
  const fetchState = vi.fn(async () => snapshot({ ci: "red", failingChecks: [check("test")] }));
  const gate = pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  );
  expect((await gate.next()).value).toMatchObject({ kind: "ci-red" });
  expect(readLocalHead).not.toHaveBeenCalled();
});

test("leaving the loop stops watching", async () => {
  const fetchState = vi.fn(async () => snapshot({ ci: "red", failingChecks: [check("test")] }));
  for await (const wake of pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  )) {
    expect(wake.kind).toBe("ci-red");
    break;
  }
  expect(hook.disposed).toBe(1);
  expect(hook.awaited).toBe(0);
});

test("a pr another run already holds is a claim conflict, never fetched", async () => {
  hook.conflict = { runId: "wrun_OWNER" };
  const fetchState = vi.fn(async () => snapshot());

  await expect(
    pullRequestGate(
      pr,
      { fetchState, readLocalHead, branchContains },
      { scope: SCOPE, approval: APPROVAL },
    ).next(),
  ).rejects.toThrow("is already claimed by run wrun_OWNER");
  expect(fetchState).not.toHaveBeenCalled();
  expect(hook.disposed).toBe(1);
});
test("pr token, including dots and dashes in names", () => {
  expect(pullRequestToken({ owner: "acme-inc", repo: "api.v2", number: 41 })).toBe(
    "github:pr:acme-inc/api.v2#41",
  );
});

test("a remote typed in lowercase matches a webhook naming GitHub's canonical casing", () => {
  const gate = pullRequestToken({ owner: "junglescout", repo: "data-lake-airflow", number: 1 });
  const webhook = tokenFromGitHubPayload({
    pull_request: { number: 1 },
    repository: { name: "Data-Lake-Airflow", owner: { login: "Junglescout" } },
  });
  expect(webhook).toBe(gate);
  expect(gate).toBe("github:pr:junglescout/data-lake-airflow#1");
});

test("a remote typed in canonical casing matches a lowercase webhook", () => {
  const gate = pullRequestToken({ owner: "Junglescout", repo: "Data-Lake-Airflow", number: 1 });
  const webhook = tokenFromGitHubPayload({
    check_run: { pull_requests: [{ number: 1 }] },
    repository: { name: "data-lake-airflow", owner: { login: "junglescout" } },
  });
  expect(webhook).toBe(gate);
});

test("the gate claims the casing-independent token", async () => {
  const pr = { owner: "Junglescout", repo: "API", number: 7 };
  const fetchState = vi.fn(async () => snapshot({ state: "closed" }));
  await pullRequestGate(
    pr,
    { fetchState, readLocalHead, branchContains },
    { scope: SCOPE, approval: APPROVAL },
  ).next();
  expect(createHook).toHaveBeenCalledWith({ token: "github:pr:junglescout/api#7" });
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
  expect(tokenFromGitHubPayload(payload)).toBe(
    pullRequestToken({ owner: "acme-inc", repo: "api.v2", number: 41 }),
  );
});

test("an issue_comment on a pull request routes to the pr token", () => {
  const repository = { name: "api", owner: { login: "acme" } };
  expect(
    tokenFromGitHubPayload({
      action: "created",
      issue: { number: 41, pull_request: { url: "https://api/pulls/41" } },
      comment: { id: 5, body: "one more thing" },
      repository,
    }),
  ).toBe(pullRequestToken({ owner: "acme", repo: "api", number: 41 }));

  // The same event shape on a plain issue names no pull request.
  expect(
    tokenFromGitHubPayload({
      action: "created",
      issue: { number: 41 },
      comment: { id: 5, body: "one more thing" },
      repository,
    }),
  ).toBe(null);
});

test("check_suite and check_run route through their pull_requests list", () => {
  const repository = { name: "api", owner: { login: "acme" } };
  const expected = pullRequestToken({ owner: "acme", repo: "api", number: 41 });
  expect(
    tokenFromGitHubPayload({
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
    tokenFromGitHubPayload({
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
    tokenFromGitHubPayload({
      action: "completed",
      check_suite: { id: 9, conclusion: "success", pull_requests: [] },
      repository: { name: "api", owner: { login: "acme" } },
    }),
  ).toBe(null);
});

test("a github ping payload is unroutable", () => {
  expect(
    tokenFromGitHubPayload({
      zen: "Keep it logically awesome.",
      hook_id: 1,
      repository: { name: "api", owner: { login: "acme" } },
    }),
  ).toBe(null);
  expect(tokenFromGitHubPayload(null)).toBe(null);
  expect(tokenFromGitHubPayload("pull_request")).toBe(null);
  expect(tokenFromGitHubPayload({ pull_request: { number: "41" }, repository: {} })).toBe(null);
});
