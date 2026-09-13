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
harness and prompt. Each budget — `implementationReviewRounds`, `ciFixAttempts`,
`pullRequestRevisionRounds` — carries that name on the whole operation and on
each phase. Handle every outcome: `merged`, `closed`, `limit-reached`,
`stopped`, `uncommitted-work`. Remove worktrees only after `merged`. A
continuation comes from `onLimit`, which is workflow-side and may suspend on a
human, typically through `haltForHuman` on the run's ticket.

`docs/delivery.md` in the jigs repository holds the delivery graph, what each
budget buys, and compiling examples of all of this. Read it before writing
delivery configuration instead of reconstructing the shape from memory. Keep
factory prompt overrides beside their callers.

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
