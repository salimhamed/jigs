# Delivery from a factory

The optional `/delivery` module implements software changes and follows their
pull requests. Other workflows can use `/agents` without any delivery concepts.
All examples run inside a factory workflow or a replay-safe block.

## Choose agents and limits

Import the bound operation from your generated `jigs.ts`:

```ts
import { claude, codex } from "@salimhamed/jigs/agents";
import { reviewLoop } from "../jigs.ts";

const result = await reviewLoop({
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

One implementation-review round includes an implementation attempt followed by
an independent review of what that attempt committed. The implementation agent
commits its own work; if it leaves the worktree dirty or adds no commit, the
round stops with `status: "uncommitted-work"` before any review, and the
worktree is retained. The loop stops early on approval, recording the reviewed
commit on the change. CI repairs and batches
of PR feedback have separate budgets; duplicate notifications do not consume them.
Counters are cumulative, including CI failures after earlier successful checks.
Zero permits no attempts in that phase and returns a limit outcome when work is needed.

`ciRepair` and `pullRequestRevision` default to the implementation harness.
`pullRequestDescription` also defaults to that harness, with a separate call.
Override each with its own `{ harness, prompt }`. Sessions are kept per role;
they are never passed between incompatible harness configurations. Reviews start
fresh so their verdict does not inherit the implementation conversation.

## Own the prompts

Each role accepts a function receiving `DeliveryPromptContext`. It includes the
work item, worktree, attempt number, prior findings, human instructions, and any
relevant diff, review threads, or failed checks. Return the full instructions for
that role. The output schema remains owned by the operation.

```ts
import type { DeliveryPromptContext } from "@salimhamed/jigs/delivery";

const review = {
  harness: claude({ model: "opus" }),
  prompt: (context: DeliveryPromptContext) => `
Review the changes since ${context.worktree.baseSha} against these requirements:
${context.task.instructions}

Check authorization and migration compatibility. Do not edit files.
Return approved only if no changes are needed; otherwise list actionable findings.
`,
};
```

A description role can also provide `transform(description, task)` to enforce
factory title and body conventions after the model responds.

## Supply your own work items

Factories own their domain types. Delivery needs only a small view:

```ts
import type { WorkItem } from "@salimhamed/jigs/delivery";

type Incident = {
  reference: string;
  service: string;
  symptoms: string;
  acceptance: string[];
};

function deliveryTask(incident: Incident): WorkItem {
  return {
    key: incident.reference,
    title: `Repair ${incident.service}`,
    instructions: [incident.symptoms, ...incident.acceptance].join("\n"),
  };
}
```

A factory can load an incident, GitHub issue, or another source in its own durable
step, then pass `deliveryTask(incident)` to `reviewLoop`. Custom prompts can close
over the richer incident data. No plugin registration or change to jigs is needed.
Generic workflows such as S3 analysis do not need to use `WorkItem` at all.

Ticket acquisition, claims, clarification, progress notes, and human communication
are separate capabilities. The starter factory explicitly resolves and claims its
Linear ticket before delivery. Replacing that factory block can change the source
without changing the review loop. An input named `ticket` has no special behavior.
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
  openPullRequestForChange,
  followPullRequest,
} from "../jigs.ts";

const built = await implementAndReview({
  task,
  worktree,
  implementation,
  review,
  maxRounds: 5,
});
if (built.status !== "approved") return built;

await checkSecurity(built.change);
const pr = await openPullRequestForChange({
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

Only an approved change types as the input to `openPullRequestForChange`: an
`ApprovedChange` carries `approval.reviewedCommit`, and a stopped result's change
does not. Publication pushes that commit and opens the pull request — it runs no
implementation agent and makes no commit, and it throws when the worktree is
dirty or its head has moved off the reviewed commit.

For different execution behavior, use `bindDeliverySteps` with the generated
`deliverySteps` object and replace a named operation. Keep custom bindings in
`blocks/`; regenerate `jigs.ts` rather than editing it.

## Generic agent workflows

`agent` and `ask` accept a harness, prompt, and optional output schema. `agent`
also accepts a working directory and optional session. `ask` runs without tools.
`createRunDirectory()` provides run-owned scratch space without a repository;
`removeRunDirectory()` removes it after successful completion. Suspension must
retain the directory, so do not put its removal in a `finally` block.
