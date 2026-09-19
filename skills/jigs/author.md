# Author a workflow

Work in the factory repo. Read its `jigs.config.ts`, generated `jigs.ts`, and
existing `workflows/`, `blocks/`, and `steps/` before editing. The installed
`node_modules/@salimhamed/jigs/templates/` is the bare scaffold for that version; its only workflow is `hello`.
For the ship process, run `jigs recipe add ship`, then manually add the printed
`ship: () => import("./workflows/ship.ts"),` line to the config's `workflows` map.
The command preserves existing files and reports created/kept paths. Recipes
become editable factory source; upgrades only regenerate `jigs.ts`.

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
Signal an unhappy ending by throwing `JigsError`, imported with
`import { JigsError } from "@salimhamed/jigs"`; a value returned from a workflow
is treated as success. Its optional second constructor argument is the `hint`
an operator reads.
Names and paths can be improved, but changing them changes durable addresses:
check active and parked runs before deploying a rename, and arrange their
completion or cancellation with the operator.

Import reusable library code from `@salimhamed/jigs/blocks/<topic>`. The seven
topics are `agents`, `human`, `linear`, `pull-requests`, `workspaces`, `git`
and `runtime`. Implementations under `steps/<topic>` belong inside durable
wrapper bodies. The generated wrappers preserve their names when library
implementation paths move.

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

Call `await release()` from `#jigs` as the workflow's last successful action.
It returns a report for worktrees, branch refs and the run directory, explaining
anything retained. The default is `{ onSuccess: "release", onFailure: "keep" }`.
Set `release` on the factory config or workflow entry; `release(policy)` wins
over both when a successful workflow chooses from its inputs.

Failed runs retain files until manual `jigs sweep`. Its `onFailure` setting
uses the current workflow/factory config; a callsite override is not persisted
for later sweep. `keep` requires operator confirmation or `--force`; `release`
permits a requested clean pass. Neither starts background cleanup. Live and
suspended runs retain resources regardless of force.

Release is success-only: never call it from `finally` or a catch, because
suspension throws too. Dirty unmerged work stays, and branches are deleted only
when their commits are proven present on the remote default branch. Squash
merges may therefore retain branches. Inspect the report when resource removal
fails. Before upgrading across the renamed release step, finish or cancel
active and parked runs with the operator.

Configuration values vary by factory; requirements belong to the workflow
declaration next to its input schema.

### Claim before protected work

Resolve the ticket, then claim it, then do everything else. The claim is the
one-active-run-per-ticket lock. A run that provisions, posts, writes, or pushes
before claiming can collide with the run that already holds the ticket. Use
`acquireTicket` to resolve, claim, and snapshot in the required order before
starting protected work.

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
bind the appropriate module: `bindAgentSteps` from
`@salimhamed/jigs/blocks/agents`, `bindLinearSteps` from
`@salimhamed/jigs/blocks/linear`, or `bindPullRequestSteps` from
`@salimhamed/jigs/blocks/pull-requests`. Generated integration exports each
module's dependencies for selective replacement. Keep functions workflow-side;
never send a prompt or callback through a durable step argument.

### Record a custom resource

After a workflow creates something an operator may need to find, call the
generated `registerResource({ kind, identity, url })` step from `#jigs`. Kind
plus identity is stable: retrying the same URL is idempotent, while a later URL
updates that identity. `jigs logs` reads these records independently of the
workflow's result.

Keep a non-idempotent external creator and registration as two durable steps.
Await the creator, then register what it returned; replay reuses the creator's
recorded result and retries registration without recreating the external
resource. An idempotent custom step may instead import `registerResource` from
`@salimhamed/jigs/steps/runtime` and call it before returning.

Use a short stable identity and an absolute URL. The SDK allows 64 total run
attributes, including other user and reserved keys, a 256-character encoded
key, and a 256 UTF-8-byte value. Registration reports these constraints and
preserves the original strings. Treat the record as observability only:
deletion requires separate kind-specific ownership and policy; a recorded URL
does not authorize cleanup.

For delivery, run `jigs recipe add ship` and register the workflow as the
command instructs. The copied `blocks/delivery/` contains the phases, types,
prompts and renderers; these are factory code to edit, not library exports.
`docs/delivery.md` in the jigs repository describes this recipe's graph, budgets
and compiling examples. Read it when changing the ship process. Keep factory
prompt overrides beside their callers.

Extract a shipped block only when both a recipe and at least one concrete
prototype use the same mechanism. Name both callers; single-caller composition
stays in the recipe. Reuse existing blocks for comment scoping and agent-session
rebuilding rather than duplicating their mechanics.

## Marker convention for bespoke pull request workflows

A pull request keeps its own progress. Every comment jigs posts carries a hidden
marker naming a `scope`, the run, a `kind` (`reply`, `completion` or `status`)
and the `source` it answers — a comment as `id@updatedAt`, or a commit sha. A
`status` marker also carries a `reason`: `merge` and `ci` stand that commit
down, so nothing tries it again, while `merge-retry` only records that a
refusal jigs is waiting out was already reported and leaves the commit
merge-ready.
`classifyPullRequestState(snapshot, scope)` derives what is outstanding from a fresh
snapshot and those markers, so nothing is remembered between wakes and a
replacement run continues where the last one stopped.

Writing your own pull request workflow: choose one scope and keep it, since it
is what "already answered" is measured against. `defaultPullRequestScope(ticketKey)`,
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
under a scope of your own, and the ship recipe's comments will read as neither your
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
