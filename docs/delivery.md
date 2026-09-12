# Delivery from a factory

The optional `/delivery` module implements software changes and follows their
pull requests. **Delivery** is the whole of it: implementation, code review,
publication, pull-request feedback, CI repair, and merge or closure, coordinated
by `deliverChange`. The **review loop** is the part `implementAndReview`
coordinates: implementation and code review repeated until approval or the
configured limit. Other workflows can use `/agents` without any delivery
concepts. All examples run inside a factory workflow or a replay-safe block.

## Choose agents and budgets

Import the bound operation from your generated `jigs.ts`:

```ts
import { claude, codex } from "@salimhamed/jigs/agents";
import { deliverChange } from "../jigs.ts";

const result = await deliverChange({
  task,
  worktree,
  binding: "application",
  implementation: { harness: codex({ model: "gpt-5.6-sol" }) },
  review: { harness: claude({ model: "opus" }) },
  limits: {
    implementationReviewRounds: 5,
    ciFixAttempts: 3,
    pullRequestRevisionRounds: 4,
  },
  merge: "human",
});
```

The three budgets carry the same names wherever they appear — on `deliverChange`,
on a single phase, and on the scaffold workflow's inputs.
One `implementationReviewRounds` round is one implementation attempt followed by
an independent review of what that attempt committed. The implementation agent
commits its own work; if it leaves the worktree dirty or adds no commit, the
round stops with `status: "uncommitted-work"` before any review, and the
worktree is retained. The review loop stops early on approval, recording the reviewed
commit on the change. `ciFixAttempts` and `pullRequestRevisionRounds` are
separate cumulative budgets; duplicate notifications do not consume them.
Counters are cumulative, including CI failures after earlier successful checks.
Zero permits no attempts in that phase and returns a limit outcome when work is needed.

`ciRepair` and `pullRequestRevision` default to the implementation harness.
`pullRequestDescription` also defaults to that harness, with a separate call.
Override each with its own `{ harness, prompt }`. Sessions are kept per role;
they are never passed between incompatible harness configurations. Reviews start
fresh so their verdict does not inherit the implementation conversation.

## Own the prompts

Each role accepts a `prompt` function receiving a context shaped for that role
alone, and returning a string or a promise of one. The output schema stays owned
by the operation, whatever the prompt says.

| Role | Context | Beyond `task`, `worktree`, `attempt` |
| --- | --- | --- |
| `implementation` | `ImplementationPromptContext` | `findings`, `instructions`, `diff?` |
| `review` | `ReviewPromptContext` | `baseCommit`, `headCommit`, `diff`, `instructions` |
| `ciRepair` | `CiRepairPromptContext` | `failing`, `pr`, `instructions`, `diff?` |
| `pullRequestRevision` | `PullRequestRevisionPromptContext` | `threads`, `reviewBody?`, `pr`, `instructions`, `diff?` |
| `pullRequestDescription` | `DescriptionPromptContext` | `diff` (no `attempt`) |

The review role is never given the previous round's `findings`: it reads the
committed diff fresh every round, and `instructions` is how a human's direction
from `onLimit` reaches it.

An optional `diff` is present only when the role runs in a fresh session, which
is the one arm that has to rebuild context; a resumed agent already holds the
change and is never charged a diff read. The review role runs fresh every round,
so its diff is always there.

Every context carries `renderDefaultPrompt()`, which renders what jigs would
have sent for this attempt. Await it to extend the default:

```ts
import type { ReviewPromptContext } from "@salimhamed/jigs/delivery";

const review = {
  harness: claude({ model: "opus" }),
  prompt: async (context: ReviewPromptContext) =>
    `${await context.renderDefaultPrompt()}

Also check authorization and migration compatibility.`,
};
```

Ignore it and the default is replaced outright — an equally supported use:

```ts
const review = {
  harness: claude({ model: "opus" }),
  prompt: (context: ReviewPromptContext) => `
Review ${context.headCommit} against these requirements:
${context.task.instructions}

${context.diff}

Do not edit files. Return approved only if no changes are needed;
otherwise list actionable findings.
`,
};
```

The shipped renderers are exported too, for a role that wants one verbatim with
its own additions: `defaultImplementationPrompt`, `defaultReviewPrompt`,
`defaultCiRepairPrompt`, `defaultRevisionPrompt`, and `defaultDescriptionPrompt`.

A description role can also provide `transform(description, task)` to enforce
factory title and body conventions after the model responds.

## Supply your own work items

Factories own their domain types. Delivery needs only a small view — `key`,
`title`, `instructions`, and an optional `url` — and keeps whatever else the
task carries:

```ts
import type { WorkItem } from "@salimhamed/jigs/delivery";

type Incident = WorkItem & {
  service: string;
  acceptance: string[];
};

declare const outage: {
  reference: string;
  service: string;
  symptoms: string;
  acceptance: string[];
};

const incident: Incident = {
  key: outage.reference,
  title: `Repair ${outage.service}`,
  instructions: outage.symptoms,
  service: outage.service,
  acceptance: outage.acceptance,
};
```

Pass `task: incident` and the task type is inferred: no explicit generic
argument and no cast. `context.task.service` is reachable from every prompt
context, from `limit.task` in `onLimit`, and from `result.change.task` when the
delivery returns. Task values are recorded durably, so keep them plain
serializable data; prompts and callbacks stay in workflow-side configuration.

A factory can load an incident, GitHub issue, or another source in its own durable
step, then pass it to `deliverChange`. No plugin registration or change to jigs is
needed. Generic workflows such as S3 analysis do not need to use `WorkItem` at all.

Ticket acquisition, claims, clarification, progress notes, and human communication
are separate capabilities. The starter factory explicitly resolves and claims its
Linear ticket before delivery. Replacing that factory block can change the source
without changing the delivery. An input named `ticket` has no special behavior.
Declare the providers you use under `requires.integrations`, such as `["linear",
"github"]`; an agent-only workflow can omit that property.

## Decide what happens at a limit

Without `onLimit`, exhausted budgets return `status: "limit-reached"`, including
the phase, findings, counters, and available change/PR data. Other outcomes are
`merged`, `closed`, `stopped`, and `uncommitted-work`, whose `findings` say why
the implementation was not reviewable. Remove worktrees only after `merged`.

For durable human intervention, supply a workflow-side callback:

```ts
onLimit: async (limit) => {
  const reply = await requestDirection(limit);
  return {
    action: "continue",
    instructions: reply.body,
    additionalAttempts: 2,
  };
},
```

`requestDirection` is factory code. It may use Linear clarification, another
channel, or Workflow hooks. The callback grants more attempts only to the exhausted
phase; counters do not reset. Return `{ action: "stop" }` to stop explicitly.
Keep callbacks outside durable step arguments, which must contain data only.

`onLimit` is the continuation mechanism. A returned terminal result is useful for
inspection; it is not a checkpoint that can restart an interrupted phase in a new run.

## Compose the phases

Use the complete loop, or place factory decisions between its phases:

```ts
import {
  implementAndReview,
  publishApprovedChange,
  followPullRequest,
} from "../jigs.ts";

const built = await implementAndReview({
  task,
  worktree,
  implementation,
  review,
  limits: { implementationReviewRounds: 5 },
});
if (built.status !== "approved") return built;

await checkSecurity(built.change);
const pr = await publishApprovedChange({
  change: built.change,
  binding: "application",
  implementation,
});
return followPullRequest({
  change: built.change,
  pr,
  implementation,
  limits: { ciFixAttempts: 3, pullRequestRevisionRounds: 4 },
  merge: "human",
});
```

`checkSecurity` is a factory-owned operation. Each delivery phase still uses
individual durable steps internally, so completed operations remain recorded.

Only an approved change types as the input to `publishApprovedChange`: an
`ApprovedChange` carries `approval.reviewedCommit`, and a stopped result's change
does not. Publication pushes that commit and opens the pull request — it runs no
implementation agent and makes no commit, and it throws when the worktree is
dirty or its head has moved off the reviewed commit.

For different execution behavior, use `bindDeliverySteps` with the generated
`deliverySteps` object and replace a named operation. Keep custom bindings in
`blocks/`; regenerate `jigs.ts` rather than editing it.

## Generic agent workflows

`runAgent` and `askModel` accept a harness, prompt, and optional output schema.
`runAgent` also accepts a working directory and optional session. `askModel`
runs without tools.
`createRunDirectory()` provides run-owned scratch space without a repository;
`removeRunDirectory()` removes it after successful completion. Suspension must
retain the directory, so do not put its removal in a `finally` block.
