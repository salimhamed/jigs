# Author a workflow

Work in the factory repo. Read its `jigs.config.ts`, generated `jigs.ts`, and
existing `workflows/`, `blocks/`, and `steps/` before editing. The installed
`node_modules/@salimhamed/jigs/templates/` is the scaffold for that version.

## Code responsibilities

- A workflow is a named process with a `"use workflow"` async function.
- A block coordinates durable steps and makes replay-safe decisions. It has no
  directive. No filesystem, network, environment reads, or Node built-ins.
- A step has `"use step"` and performs work the runtime records. Keep custom
  steps in `steps/`; their implementations may use Node and external services.
- `jigs.ts` is generated and committed. Import built-in steps and bound blocks
  from it as `#jigs`. Never add custom behavior or prompts there. `jigs generate`
  refreshes it; builds check for drift and upgrades regenerate it automatically.
- Imports are anchored at the factory root by the `imports` map in its
  `package.json`: `#jigs`, `#blocks/<path>`, `#steps/<path>`, never `../`. The
  deferred workflow loaders in `jigs.config.ts` stay relative.

A workflow calls blocks and steps. A step calls an implementation. Only the
factory carries directives, so library version changes do not rename its steps.
Names and paths can be improved, but changing them changes durable addresses:
check active and parked runs before deploying a rename, and arrange their
completion or cancellation with the operator.

## Add a workflow

1. Write `workflows/<name>.ts` with a zod input schema and an exported async
   function whose first statement is `"use workflow"`.
2. Type inputs as `WorkflowInputs<typeof inputs>`. Only `triggerId` is injected.
   Resolve and claim tickets explicitly in factory code; a `ticket` input has no special behavior.
3. Default-export `{ workflow: functionName, inputs, requires }` from the module.
4. Register `name: () => import("./workflows/<name>.ts")` in the config's
   `workflows` object. Keep imports deferred so operating commands don't load
   workflow code.
5. Build and test the factory. Its config test checks the emitted durable IDs.

Teardown is a plain last call, never a `finally`: suspension can throw, and a
parked run must retain its worktree. Configuration values vary by factory;
requirements belong to the workflow declaration next to its input schema.

## Validation ownership

Give the responsible agent the acceptance criteria and repository access. It
inspects repository guidance, chooses and runs appropriate checks, and records
the tested revision, commands, results, evidence locations, and unresolved gaps.
An independent reviewer assesses that exact revision and whether the evidence
supports each criterion; it can run further checks before approving.

Workflow code owns durable sequencing, separate session continuation, artifact
handoffs, and general result gates. Keep deterministic guards for session identity,
iteration limits, required evidence fields, explicit approval, and publishing only
the approved clean revision. Repository-specific validation belongs in agent work:
commands, environment setup, wrapper names, and filesystem layout are discovered
from the repository rather than guessed in a ticket-specific validation step.

When validation fails, return the findings and evidence to the responsible agent
within the workflow's revision loop. That agent investigates and repairs the work
or reports a blocker. A different implementation choice should not require editing
and redeploying the workflow's validation program. Retain concrete evidence through
review and cleanup; a success flag alone does not establish acceptance.

## Customize blocks and steps

Pass typed prompt overrides directly to jigs blocks. For shared defaults, write
one custom block wrapping the shipped block, with defaults before the spread
of caller options so a call site can override them.

For different durable behavior, write a named custom `"use step"` function and
bind the appropriate module: `bindAgentSteps`, `bindLinearSteps`,
`bindPullRequestSteps`, or `bindDeliverySteps`. Generated integration exports each
module's dependencies for selective replacement. Keep functions workflow-side;
never send a prompt or callback through a durable step argument.

For delivery, use `deliverChange` or compose `implementAndReview`,
`publishApprovedChange`, and `followPullRequest`. Each role takes its own
harness and prompt. The review role keeps its own session across rounds and
blocks only on findings it marked blocking; the rest are appended to the pull
request description. A budget that runs out with no `onLimit` pushes the branch
and posts a ticket note before the run ends. Each budget — `implementationReviewRounds`, `ciFixAttempts`,
`pullRequestRevisionRounds` — carries that name on the whole operation and on
each phase. A delivery returns its approved change and pull request only after
merge; it throws after preserving the branch and posting the ticket note when
it stops short. A continuation comes from `onLimit`, which is workflow-side and may suspend on a
human, typically through `haltForHuman` on the run's ticket.

`docs/delivery.md` in the jigs repository holds the delivery graph, what each
budget buys, and compiling examples of all of this. Read it before writing
delivery configuration instead of reconstructing the shape from memory. Keep
factory prompt overrides beside their callers.

## Marker convention for bespoke pull request workflows

A pull request keeps its own progress. Every comment jigs posts carries a hidden
marker naming a `scope`, the run, a `kind` (`reply`, `completion` or `status`)
and the `source` it answers — a comment as `id@updatedAt`, or a commit sha. A
`status` marker also carries a `reason`: `merge` and `ci` stand that commit
down, so nothing tries it again, while `merge-retry` only records that a
refusal jigs is waiting out was already reported and leaves the commit
merge-ready.
`classifyPrState(snapshot, scope)` derives what is outstanding from a fresh
snapshot and those markers, so nothing is remembered between wakes and a
replacement run continues where the last one stopped.

Writing your own pull request workflow: choose one scope and keep it, since it
is what "already answered" is measured against. `defaultPrScope(ticketKey)`,
which every delivery uses unless you pass `scope`, is the workflow function's
own name plus that key — so renaming the function changes the scope and a pull
request parked mid-conversation stops recognising its own answers, the same
rule that governs durable step ids. Pass an explicit `scope` when you want one
that outlives a rename. Post through `postReviewAnswers` and
`postPullRequestNote` so answers are marked. They post once and never re-read:
the snapshot at the top of the wake is the check, and a post that fails ends
the wake rather than the run, so the next wake reposts what is still
unanswered. A workflow that only reads a pull request must
not call `pullRequestGate`: the `github:pr:` hook is an exclusive writer claim
and a second holder fails. Read on a schedule with the snapshot step instead,
under a scope of your own, and jigs' delivery comments will read as neither your
feedback nor your completed work.

## Configuration and schedules

`jigs.config.ts` declares ports, ingress URL, bindings, deferred workflow imports
and schedules. Declare used credential providers in `requires.integrations`. Secrets remain in `.env`. A schedule names a `workflow`, cron
expression and inputs; the service validates its inputs against the workflow's
schema. An active prior run causes a tick to be skipped; downtime isn't replayed.

Use `jigs bind` and `jigs unbind` for literal binding declarations. Unsupported
computed expressions fail with guidance before any file or webhook changes.
Do not replace such expressions automatically to make an edit work.

## Verify

```sh
pnpm typecheck
pnpm exec jigs build
pnpm test
```

A running service needs `jigs up` to pick up changes. Check active runs before
restarting it. Never run standalone `workflow web` against its World; the
service hosts its own dashboard. Cancellation and destructive worktree cleanup
require operator authorization unless already authorized in the session.
