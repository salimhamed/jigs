import type { WorktreeFacts } from "jigs";
import { type AgentStepConfig, claude } from "jigs/steps";
import { beforeEach, expect, test } from "vitest";
import type { CheckRun, ReviewThread } from "../providers/github";
import { parseOutput, ResumeFailedError } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import type { GateWake } from "../suspension/pull-request-gate";
import type { PrRef } from "../suspension/tokens";
import type { Handoff } from "../ticket/review";
import type { TicketSnapshot } from "../ticket/snapshot";
import { PrClosedUnmergedError, type ReviewLoopDeps, reviewLoop } from "./loop";

const claim = {
  issueId: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  token: "linear:ticket:68bc9696-35d5-442d-ab56-214c8cfefbec",
} as TicketClaim;

const snapshot: TicketSnapshot = {
  fetchedAt: "2026-08-26T13:00:00Z",
  id: claim.issueId,
  identifier: "AGE-316",
  title: "Review loop jig",
  description: "## Acceptance criteria\n\n- the builder answers in-thread",
  url: "https://linear.app/x/issue/AGE-316",
  branchName: "salimhamed/age-316-review-loop",
  state: "Todo",
  labels: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  links: [],
  subIssues: [],
};

const handoff: Handoff = { brief: "build it", snapshot };

const worktree: WorktreeFacts = {
  path: "/tmp/worktree",
  branch: snapshot.branchName,
  resolution: "new",
  defaultBranch: "main",
  baseSha: "base-sha-1",
  headSha: "head-sha-1",
  behindDefault: 0,
};

const pr: PrRef = { owner: "acme", repo: "api", number: 41 };

const thread = (rootId: number): ReviewThread => ({
  rootId,
  path: "src/gate.ts",
  line: 12,
  comments: [
    {
      id: rootId,
      rootId,
      body: `comment on ${rootId}`,
      user: "reviewer",
      path: "src/gate.ts",
      line: 12,
      createdAt: "2026-08-26T12:00:00Z",
    },
  ],
});

const failing: CheckRun[] = [
  { name: "test", conclusion: "failure", url: "http://ci.test/1" },
];

const ciRed = (
  headSha: string,
  mentionLogin: string | null = "salim",
): GateWake => ({ kind: "ci-red", headSha, failing, mentionLogin });

type Describe = Parameters<ReviewLoopDeps["describePr"]>[0];

type Calls = {
  agent: AgentStepConfig<unknown>[];
  pushes: Array<[string, string, string]>;
  replies: Array<[number, string]>;
  comments: string[];
  merges: number[];
  describes: Describe[];
  opens: Array<[string, string]>;
  needsHuman: number;
  gateFinished: boolean;
};

let calls: Calls;
let agentOutputs: unknown[];

function makeDeps(wakes: GateWake[]): ReviewLoopDeps {
  return {
    agent: (async <T>(config: AgentStepConfig<T>) => {
      calls.agent.push(config as AgentStepConfig<unknown>);
      const raw =
        config.output === undefined ? undefined : agentOutputs.shift();
      return {
        text: "",
        output: parseOutput(config.output, raw),
        files: [],
        usage: undefined,
        session: { harness: "claude" as const, id: `s-${calls.agent.length}` },
      };
    }) as ReviewLoopDeps["agent"],
    needsHuman: (async () => {
      calls.needsHuman += 1;
      return {
        commentId: "c1",
        body: "carry on",
        author: { id: "u1", name: "salim" },
        createdAt: "2026-08-26T14:00:00Z",
      };
    }) as ReviewLoopDeps["needsHuman"],
    gate: async function* gate() {
      yield* wakes;
      calls.gateFinished = true;
    } as unknown as ReviewLoopDeps["gate"],
    resolveRepo: async () => ({ owner: pr.owner, repo: pr.repo }),
    pushWorktreeBranch: async (path, branch, baseSha) => {
      calls.pushes.push([path, branch, baseSha]);
      return {
        commits: 1,
        headSha: `pushed-${calls.pushes.length}`,
        dirty: false,
      };
    },
    describePr: async (input) => {
      calls.describes.push(input);
      return { title: "described title", body: "described body" };
    },
    openPr: async (_repo, _head, _base, title, body) => {
      calls.opens.push([title, body]);
      return pr;
    },
    replyInThread: async (_pr, rootId, body) => {
      calls.replies.push([rootId, body]);
    },
    commentOnPr: async (_pr, body) => {
      calls.comments.push(body);
    },
    squashMerge: async (target) => {
      calls.merges.push(target.number);
      return { merged: true, sha: "merge-sha" };
    },
    readDiff: async () => "THE-DIFF",
  };
}

// The first `empty` pushes report a dirty worktree and no commits; every push
// after them carries one.
const emptyPushes =
  (empty: number): ReviewLoopDeps["pushWorktreeBranch"] =>
  async (path, branch, baseSha) => {
    calls.pushes.push([path, branch, baseSha]);
    const commits = calls.pushes.length > empty ? 1 : 0;
    return {
      commits,
      headSha: `pushed-${calls.pushes.length}`,
      dirty: commits === 0,
    };
  };

const commitRounds = () =>
  calls.agent.filter((call) => call.prompt.startsWith("# Commit your work"));

const approved = { verdict: "approved", findings: [] };
const answerFor = (rootIds: number[]) => ({
  answers: rootIds.map((threadId) => ({
    threadId,
    body: `answered ${threadId}`,
  })),
});

const run = (deps: ReviewLoopDeps, merge: "jigs" | "human" = "jigs") =>
  reviewLoop(
    {
      claim,
      handoff,
      harness: claude({ model: "sonnet" }),
      worktree,
      binding: "scratch",
      merge,
    },
    deps,
  );

beforeEach(() => {
  calls = {
    agent: [],
    pushes: [],
    replies: [],
    comments: [],
    merges: [],
    describes: [],
    opens: [],
    needsHuman: 0,
    gateFinished: false,
  };
  // The first review verdict every test needs before the PR is opened.
  agentOutputs = [approved];
});

test("the jig implements, pushes the ticket branch and opens the PR before the gate", async () => {
  const deps = makeDeps([{ kind: "closed", merged: true }]);
  const result = await run(deps);

  expect(calls.pushes).toEqual([
    ["/tmp/worktree", snapshot.branchName, "base-sha-1"],
  ]);
  expect(result).toEqual({ pr, cycles: 1 });
});

test("an empty branch with a clean tree fails loudly instead of opening an empty PR", async () => {
  const deps = makeDeps([]);
  deps.pushWorktreeBranch = async (path, branch, baseSha) => {
    calls.pushes.push([path, branch, baseSha]);
    return { commits: 0, headSha: "base-sha-1", dirty: false };
  };
  await expect(run(deps)).rejects.toThrow(snapshot.branchName);
  // Nothing describes a branch that turned out to carry nothing.
  expect(calls.describes).toEqual([]);
  // Nothing to recover, so no commit round is spent and no second push runs:
  // implement and review are the only agent calls.
  expect(commitRounds()).toEqual([]);
  expect(calls.pushes).toHaveLength(1);
  // The jig's own failure follows the failed-run rows rather than the sweep.
});

test("an empty push with a dirty worktree sends the builder back to commit", async () => {
  const deps = makeDeps([{ kind: "closed", merged: true }]);
  deps.pushWorktreeBranch = emptyPushes(1);
  const result = await run(deps);

  const rounds = commitRounds();
  expect(rounds).toHaveLength(1);
  // Inside the builder's own session: it is the one holding the work it left
  // uncommitted.
  expect(rounds[0]?.resume).toEqual({ harness: "claude", id: "s-1" });
  expect(rounds[0]?.cwd).toBe("/tmp/worktree");
  // The second push carries the commit, so the run continues into the PR.
  expect(calls.pushes).toHaveLength(2);
  expect(calls.describes).toHaveLength(1);
  expect(result).toEqual({ pr, cycles: 1 });
});

test("a stale session commits from a fresh context rather than failing the run", async () => {
  const deps = makeDeps([{ kind: "closed", merged: true }]);
  deps.pushWorktreeBranch = emptyPushes(1);
  const live = deps.agent;
  let stale = true;
  deps.agent = (async <T>(config: AgentStepConfig<T>) => {
    if (stale && config.resume !== undefined) {
      stale = false;
      calls.agent.push(config as AgentStepConfig<unknown>);
      throw new ResumeFailedError("no rollout found for thread id 0199-gone");
    }
    return live(config);
  }) as ReviewLoopDeps["agent"];
  const result = await run(deps);

  // The same prompt either way: the work is on disk, so the fresh round needs
  // no rebuilt context of its own.
  const rounds = commitRounds();
  expect(rounds).toHaveLength(2);
  expect(rounds[0]?.resume).toEqual({ harness: "claude", id: "s-1" });
  expect(rounds[1]?.resume).toBeUndefined();
  // The throwing resume records no session, so the fresh round is s-4 — and it
  // is the one now holding the change.
  expect(calls.describes[0]?.session).toEqual({ harness: "claude", id: "s-4" });
  expect(result).toEqual({ pr, cycles: 1 });
});

test("a commit round that still commits nothing fails the run", async () => {
  const deps = makeDeps([]);
  deps.pushWorktreeBranch = emptyPushes(2);

  await expect(run(deps)).rejects.toThrow("commit-recovery round");
  // Exactly one round: the recovery is bounded, not a loop.
  expect(commitRounds()).toHaveLength(1);
  expect(calls.pushes).toHaveLength(2);
  expect(calls.describes).toEqual([]);
});

test("the factory's description is what the PR is opened with", async () => {
  const deps = makeDeps([{ kind: "closed", merged: true }]);
  await run(deps);

  // Jigs holds no title or body of its own: whatever describePr returned is
  // verbatim what GitHub gets.
  expect(calls.describes).toHaveLength(1);
  expect(calls.opens).toEqual([["described title", "described body"]]);
});

test("describePr sees the builder's session and the branch point", async () => {
  const deps = makeDeps([{ kind: "closed", merged: true }]);
  await run(deps);

  // s-1 is the implement call, so a description agent can resume the context
  // that wrote the change rather than reading the diff cold.
  expect(calls.describes[0]?.session).toEqual({ harness: "claude", id: "s-1" });
  expect(calls.describes[0]?.baseSha).toBe("base-sha-1");
  expect(calls.describes[0]?.worktreePath).toBe("/tmp/worktree");
  expect(calls.describes[0]?.handoff).toEqual(handoff);
});

test("a review-comments wake answers every thread in place", async () => {
  agentOutputs = [approved, answerFor([900, 910])];
  const deps = makeDeps([
    { kind: "review-comments", threads: [thread(900), thread(910)] },
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  expect(calls.replies).toEqual([
    [900, "answered 900"],
    [910, "answered 910"],
  ]);
  expect(calls.comments).toEqual([]);
  // The answer prompts have the builder commit its fix, so the branch has to
  // carry it before the reply claims it does.
  expect(calls.pushes).toHaveLength(2);
});

test("an answer naming a thread the wake never carried lands on the conversation", async () => {
  agentOutputs = [approved, answerFor([900, 4242])];
  const deps = makeDeps([
    { kind: "review-comments", threads: [thread(900)] },
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  expect(calls.replies).toEqual([[900, "answered 900"]]);
  expect(calls.comments).toEqual(["answered 4242"]);
});

test("a changes-requested review body is answered on the PR conversation", async () => {
  agentOutputs = [
    approved,
    { answers: [{ threadId: null, body: "addressed all four" }] },
  ];
  const deps = makeDeps([
    {
      kind: "changes-requested",
      reviewId: 7,
      reviewer: "salim",
      body: "four things need fixing",
      submittedAt: "2026-08-26T12:00:00Z",
    },
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  expect(calls.replies).toEqual([]);
  expect(calls.comments).toEqual(["addressed all four"]);
  const answering = calls.agent.at(-1);
  expect(answering?.prompt).toContain("four things need fixing");
});

test("the fourth consecutive red escalates as an @-mention instead of a fix", async () => {
  const deps = makeDeps([
    ciRed("sha-1"),
    ciRed("sha-2"),
    ciRed("sha-3"),
    ciRed("sha-4"),
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  // Three bounded fix attempts, each followed by a push.
  const fixes = calls.agent.filter((call) =>
    call.prompt.startsWith("# Fix CI"),
  );
  expect(fixes).toHaveLength(3);
  expect(fixes[0]?.prompt).toContain("attempt 1 of 3");
  expect(fixes[0]?.prompt).toContain("**test** — failure");
  expect(calls.pushes).toHaveLength(4); // the opening push plus three fixes

  expect(calls.comments).toHaveLength(1);
  expect(calls.comments[0]?.startsWith("@salim")).toBe(true);
  expect(calls.comments[0]).toContain("3 fix attempts");
  // Never needsHuman: the channel for this conversation is GitHub.
  expect(calls.needsHuman).toBe(0);
  // And the gate keeps being consumed past the escalation: the close after it
  // still reached the jig.
});

test("a fix that commits nothing escalates instead of waiting for a wake that cannot come", async () => {
  const deps = makeDeps([ciRed("sha-1"), { kind: "closed", merged: true }]);
  // No new head means no new CI event, so the gate would never wake again.
  deps.pushWorktreeBranch = async (path, branch, baseSha) => {
    calls.pushes.push([path, branch, baseSha]);
    return { commits: 1, headSha: "sha-1", dirty: false };
  };
  await run(deps);

  expect(
    calls.agent.filter((call) => call.prompt.startsWith("# Fix CI")),
  ).toHaveLength(1);
  expect(calls.comments).toHaveLength(1);
  expect(calls.comments[0]?.startsWith("@salim")).toBe(true);
  // Its own reason, not the exhausted-bound one: no attempt count was spent.
  expect(calls.comments[0]).toContain("produced no new commit");
  expect(calls.comments[0]).not.toContain("fix attempts");
});

test("the CI fix does not take over the builder's session pointer", async () => {
  agentOutputs = [approved, answerFor([900])];
  const deps = makeDeps([
    ciRed("sha-1"),
    { kind: "review-comments", threads: [thread(900)] },
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  // s-1 is the implement step: the reviewer, the CI fix and the answer all ran
  // after it, and only the implement session holds the ticket and the change.
  const answering = calls.agent.at(-1);
  expect(answering?.resume).toEqual({ harness: "claude", id: "s-1" });
});

test("the CI fix runs inside the builder's session rather than context-free", async () => {
  const deps = makeDeps([ciRed("sha-1"), { kind: "closed", merged: true }]);
  await run(deps);

  const fix = calls.agent.find((call) => call.prompt.startsWith("# Fix CI"));
  expect(fix?.resume).toEqual({ harness: "claude", id: "s-1" });
});

test("a stale session sends the CI fix into a fresh context that then holds the change", async () => {
  agentOutputs = [approved, answerFor([900])];
  const deps = makeDeps([
    ciRed("sha-1"),
    { kind: "review-comments", threads: [thread(900)] },
    { kind: "closed", merged: true },
  ]);
  const live = deps.agent;
  let stale = true;
  deps.agent = (async <T>(config: AgentStepConfig<T>) => {
    if (stale && config.resume !== undefined) {
      stale = false;
      calls.agent.push(config as AgentStepConfig<unknown>);
      throw new ResumeFailedError("no rollout found for thread id 0199-gone");
    }
    return live(config);
  }) as ReviewLoopDeps["agent"];
  await run(deps);

  // s-1 and s-2 are implement and review, the throwing resume records no
  // session, so the rebuilt fix is s-4 — and the answer resumes that.
  const fresh = calls.agent[3];
  expect(fresh?.resume).toBeUndefined();
  expect(fresh?.prompt).toContain("AGE-316");
  expect(fresh?.prompt).toContain("THE-DIFF");
  expect(calls.agent.at(-1)?.resume).toEqual({ harness: "claude", id: "s-4" });
});

test("a fifth red neither fixes nor escalates a second time", async () => {
  const deps = makeDeps([
    ciRed("sha-1"),
    ciRed("sha-2"),
    ciRed("sha-3"),
    ciRed("sha-4"),
    ciRed("sha-5"),
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  expect(
    calls.agent.filter((call) => call.prompt.startsWith("# Fix CI")),
  ).toHaveLength(3);
  expect(calls.comments).toHaveLength(1);
});

test("a green run resets the consecutive-red count", async () => {
  const deps = makeDeps([
    ciRed("sha-1"),
    ciRed("sha-2"),
    { kind: "ci-green", headSha: "sha-3" },
    ciRed("sha-4"),
    ciRed("sha-5"),
    ciRed("sha-6"),
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  expect(
    calls.agent.filter((call) => call.prompt.startsWith("# Fix CI")),
  ).toHaveLength(5);
  expect(calls.comments).toEqual([]);
});

test("with no reviewer to name the escalation falls back to the repo owner", async () => {
  const deps = makeDeps([
    ciRed("sha-1", null),
    ciRed("sha-2", null),
    ciRed("sha-3", null),
    ciRed("sha-4", null),
    { kind: "closed", merged: true },
  ]);
  await run(deps);

  expect(calls.comments[0]?.startsWith("@acme")).toBe(true);
});

test("an approval squash-merges and returns the merged PR", async () => {
  const deps = makeDeps([
    {
      kind: "approved",
      reviewId: 7,
      reviewer: "salim",
      submittedAt: "2026-08-26T12:00:00Z",
    },
    // Never reached: the jig returns on the approval.
    { kind: "closed", merged: true },
  ]);
  const result = await run(deps);

  // No title crosses the boundary: the merge reads the PR's own, so a title
  // a reviewer corrected after the PR opened is the one that ships.
  expect(calls.merges).toEqual([pr.number]);
  expect(result.pr).toEqual(pr);
  expect(calls.gateFinished).toBe(false);
});

test("a merge GitHub refuses leaves the PR open and the run listening", async () => {
  const deps = makeDeps([
    {
      kind: "approved",
      reviewId: 7,
      reviewer: "salim",
      submittedAt: "2026-08-26T12:00:00Z",
    },
    { kind: "closed", merged: false },
  ]);
  deps.squashMerge = async () => {
    throw new Error("405 Pull Request is not mergeable");
  };

  await expect(run(deps)).rejects.toThrow(PrClosedUnmergedError);
  expect(calls.comments).toHaveLength(1);
  expect(calls.comments[0]).toContain("@salim");
  expect(calls.comments[0]).toContain("not mergeable");
  // The close after it is what ends the run; its worktree stays for sweep.
});

test("in human-merges mode an approval merges nothing and keeps listening", async () => {
  const deps = makeDeps([
    {
      kind: "approved",
      reviewId: 7,
      reviewer: "salim",
      submittedAt: "2026-08-26T12:00:00Z",
    },
    { kind: "closed", merged: true },
  ]);
  const result = await run(deps, "human");

  expect(calls.merges).toEqual([]);
  expect(result.pr).toEqual(pr);
});

test("a PR closed unmerged fails the run and leaves the worktree for sweep", async () => {
  const deps = makeDeps([{ kind: "closed", merged: false }]);

  await expect(run(deps)).rejects.toThrow(PrClosedUnmergedError);
  // Teardown ran before the throw, on the failed-run rows.
});

test("a gate that stops delivering before the PR closes is an error, not a silent success", async () => {
  const deps = makeDeps([]);
  await expect(run(deps)).rejects.toThrow("stopped delivering wakes");
});
