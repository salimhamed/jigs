# Author a workflow

Work in the factory repo. Read its `jigs.config.ts`, the generated
`jigs/steps.ts` and `jigs/routines.ts`, and `workflows/` before editing. The
installed `node_modules/@jigs-ai/jigs/templates/` is the bare scaffold for that
version; its only workflow is `hello`.

The guides, in the order you need them:

- `https://salimhamed.github.io/jigs/guide/build-a-workflow`: one workflow end to end.
- `https://salimhamed.github.io/jigs/guide/recipes`: copying in a ready-made workflow such as linear-ticket-to-pr.
- `https://salimhamed.github.io/jigs/guide/configuration`: every `jigs.config.ts` key and `.env` variable.

For the linear-ticket-to-pr process, run `jigs recipe add linear-ticket-to-pr`. It adds
`"linear-ticket-to-pr": () => import("./workflows/linear-ticket-to-pr.ts"),` to the config's `workflows` map,
preserves existing files and reports created/kept paths. Recipes
become editable factory source; upgrades only regenerate `jigs/`.

## Code responsibilities

- A workflow is a named process with a `"use workflow"` async function.
- A block coordinates durable steps and makes replay-safe decisions. It has no
  directive. No filesystem, network, environment reads, or Node built-ins.
- A step has `"use step"` and performs work the runtime records. Keep a
  workflow's own steps in a `steps.ts` in its directory; their implementations
  may use Node and external services.
- A routine is a function a workflow calls that runs steps and may wait, such
  as `runAgent`, `reviewTicket` or `pullRequestGate`.
- `jigs/` is generated and committed. `jigs/steps.ts` holds every built-in step
  and is the only generated file with `"use step"`; `jigs/routines.ts` holds the
  routines bound to them. Import them as `#jigs/steps` and `#jigs/routines`.
  Never edit either. `jigs generate` refreshes them; builds check for drift and
  upgrades regenerate them automatically.
- Each workflow lives in its own directory, `workflows/<name>/<name>.ts`, with
  its own files beside it, imported with `./` paths. The deferred workflow
  loaders in `jigs.config.ts` stay relative.

A workflow calls blocks and steps. A step calls an implementation. Only the
factory carries directives, so library version changes do not rename its steps.
Signal an unhappy ending by throwing `JigsError`, imported with
`import { JigsError } from "@jigs-ai/jigs"`; a value returned from a workflow
is treated as success. Its optional second constructor argument is the `hint`
an operator reads.
Names and paths can be improved, but changing them changes durable addresses:
check active and parked runs before deploying a rename, and arrange their
completion or cancellation with the operator.

Import reusable library code from `@jigs-ai/jigs/blocks/<topic>`. The seven
topics are `agents`, `human`, `linear`, `pull-requests`, `workspaces`, `git`
and `runtime`. Implementations under `steps/<topic>` belong inside durable
wrapper bodies. The generated wrappers preserve their names when library
implementation paths move.

Read the installed API reference at `node_modules/@jigs-ai/jigs/docs/api/`;
its Markdown paths mirror the package import paths.

## Add a workflow

1. Write `workflows/<name>/<name>.ts` with a zod input schema and an exported
   async function whose first statement is `"use workflow"`.
2. Type inputs as `WorkflowInputs<typeof inputs>`. Only `triggerId` is injected.
   Resolve and claim tickets explicitly in factory code; a `ticket` input has no special behavior.
3. Default-export `defineWorkflow({ inputs, requires, workflow: functionName })`,
   importing `defineWorkflow` from `@jigs-ai/jigs`. Name each agent the
   workflow runs in `requires.agents`, as a plain object of harness
   descriptors; jigs checks the harness CLIs those agents use.
4. Register `name: () => import("./workflows/<name>/<name>.ts")` in the config's
   `workflows` object. Keep imports deferred so operating commands don't load
   workflow code.
5. Build and test the factory. Its config test checks the emitted durable IDs.

The service automatically applies the effective release policy after a run is
terminal. The default is `{ onSuccess: "release", onFailure: "keep" }`; set
`release` on the factory config or in `defineWorkflow`. Failed and cancelled runs
both use `onFailure`. Live and suspended runs retain their resources.

Call `await release()` from `#jigs/routines` as the workflow's last successful action
when it needs a report before returning. `release(policy)` persists the
callsite's success choice, so an explicit keep is not reversed by automatic
cleanup. Failed cleanup stays visible in `jigs status <run-id>`, is retried by the
service, and remains inspectable with `jigs resources list` and preview-first
`jigs resources prune`.

Release is success-only: call it on the success path, as the workflow's last
line. Dirty unmerged work stays, and branches are deleted only
when their commits are proven present on the remote default branch. Squash
merges may therefore retain branches. Inspect the report when resource removal
fails.

Configuration values vary by factory; requirements belong to the workflow
declaration next to its input schema.

### Claim before protected work

Resolve the ticket, then claim it, then do everything else. The claim is the
one-active-run-per-ticket lock. A run that provisions, posts, writes, or pushes
before claiming can collide with the run that already holds the ticket. Use
`acquireTicket` to resolve, claim, and snapshot in the required order before
starting protected work.

Post ticket notes through the claim with `noteOnTicket(claim, note)` rather
than the `postTicketNote` step. The claim records every comment the run posts,
and `haltForHuman` skips them all when it looks for a human's reply.

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
`@jigs-ai/jigs/blocks/agents`, `bindLinearSteps` from
`@jigs-ai/jigs/blocks/linear`, or `bindPullRequestSteps` from
`@jigs-ai/jigs/blocks/pull-requests`. The generated files export only what a
workflow calls, so pass your own step alongside the generated ones from
`#jigs/steps`. Keep functions workflow-side;
never send a prompt or callback through a durable step argument.

### Record a custom resource

After a workflow creates something an operator may need to find, call the
generated `registerResource({ kind, identity, url })` step from `#jigs/steps`. Kind
plus identity is stable: retrying the same URL is idempotent, while a later URL
updates that identity. `jigs status <run-id>` reads these records independently of the
workflow's result.

Keep a non-idempotent external creator and registration as two durable steps.
Await the creator, then register what it returned; replay reuses the creator's
recorded result and retries registration without recreating the external
resource. An idempotent custom step may instead import `registerResource` from
`@jigs-ai/jigs/steps/runtime` and call it before returning.

Use a short stable identity and an absolute URL. The SDK allows 64 total run
attributes, including other user and reserved keys, a 256-character encoded
key, and a 256 UTF-8-byte value. Registration reports these constraints and
preserves the original strings. Treat the record as observability only:
deletion requires separate kind-specific ownership and policy; a recorded URL
does not authorize cleanup.

For delivery, run `jigs recipe add linear-ticket-to-pr`; it registers the workflow. The copied `blocks/delivery/` contains the phases, types,
prompts and renderers; these are factory code to edit, not library exports.
Read `blocks/delivery/README.md` for the recipe's prerequisites, budgets,
prompts and compiling examples before changing the linear-ticket-to-pr process. Keep factory prompt overrides beside
their callers. Reuse existing blocks for comment scoping and agent-session
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
under a scope of your own, and the linear-ticket-to-pr recipe's comments will read as neither your
feedback nor your completed work.

## Configuration and schedules

`jigs.config.ts` declares ports, poll intervals, optional webhooks, bindings,
deferred workflow imports and schedules. Declare used credential providers in `requires.integrations`. Secrets remain in `.env`. A schedule names a `workflow`, cron
expression and inputs; the service validates its inputs against the workflow's
schema. An active prior run causes a tick to be skipped; downtime isn't replayed.

Agent harnesses don't inherit `.env`: each gets a small base set (`PATH`, `HOME`,
locale, proxies and similar) plus its driver's own variables. Give agents any
other variable by listing its name in `agents: { env: [...] }`; names only.

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
