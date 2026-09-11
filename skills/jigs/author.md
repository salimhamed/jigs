# Author a pipeline

Everything you write here lives in the **factory repo**, never in a jigs
package. jigs ships steps; the factory owns every file that names them.

## Read first

- The factory's own `steps/jigs.ts` header, then its existing `pipelines/`.
- `CONTEXT.md` in the jigs repo (github.com/salimhamed/jigs) for the
  vocabulary — pipeline, block, step, step id, step wrapper, binding, gate,
  needs-human halt, schedule.
- The worked examples, by path rather than from memory:
  - the smallest complete factory: what `jigs init` scaffolds, from
    `node_modules/@salimhamed/jigs/templates/` in this factory
    (`jigs.config.ts.tmpl`, `pipelines/ship.ts.tmpl`, `steps/jigs.ts.tmpl`,
    `blocks/jigs.ts.tmpl`, `blocks/review-loop/`) —
    the version the factory is pinned to, so it matches what is installed.
  - if the `jigs-factory-js` factory is checked out on this machine, a real
    pipeline that needs no repo binding: its `pipelines/s3-bucket-analysis.ts`,
    with the factory-local steps in `steps/aws.ts`, the agent calls in
    `steps/s3-diagnosis.ts`, and the prose in `prompts/`. If it is not checked
    out, lean on the scaffold above — it carries the same shape at one pipeline.

## The three tiers, and why they matter

1. **A `"use step"` function owns a durable id** built from its file's path and
   its own name — `step//./steps/jigs//provisionWorktree`. That id is a
   memoization key
   in the factory's World. Renaming or moving it changes the id, so it happens
   only when `jigs ps` shows no parked runs.
2. **A block is pipeline-side code** that calls those wrappers in a fixed way.
   jigs ships blocks from `@salimhamed/jigs/blocks`: `agent`, `ask`,
   `haltForHuman`, `pullRequestGate`, `agentOrHalt`, `reviewTicket`,
   `implementUntilCodeReviewApproves`, `answerReview`, `fixCi`, `commitWork`,
   `postReviewAnswers`, `describePr`, `attend`. A factory writes its own
   blocks too. No directive, no id. Renaming one is safe.
3. **A pure helper** is neither, carries no id, and is the easy thing to unit
   test.

The review loop is the factory's own blocks over the jigs ones, scaffolded into
`blocks/review-loop/`, one decision per file. Read it before changing how a run
behaves: the order, the CI bound, the merge policy and the escalation prose are
all there, and none of it is a jigs release away. The cap on
implement-and-review rounds is the exception. It lives inside
`implementUntilCodeReviewApproves`, with the session and the brief that call
keeps out of the reviewer's prompt.

A pipeline imports its steps from `../steps/jigs.ts`, **never** from
`@salimhamed/jigs/steps`. A step reached through the package is addressed by
the package's version instead of by the factory's path, so every upgrade would
rename it. The rule is about steps alone: a pipeline imports blocks from
`../blocks/jigs.ts`, and imports `ticketInput`, `claimTicket`, `claude` and
`codex` from the package directly, because a block, a harness constructor and
a type carry no id. The factory's ids test is what catches the difference.

That ids test is a `jigs.config.test.ts` in the factory root: it reads the
emitted ids out of the last build and asserts their shape — no package version
in any of them, and every one addressed by a path inside the factory. `jigs
init` scaffolds it, and the jigs repo's `e2e/check-step-ids.mjs` holds the
scaffold's own ids to the list in `e2e/expected-ids.txt`. A factory that wants
its exact ids pinned as well can add the list; whether it does or not, a
rename is invisible at build time, so check `jigs ps` before one.

## Add a pipeline

1. A new file under `pipelines/`, exporting two things: a zod `inputs` schema
   (which doubles as the `--input` contract) and the pipeline function whose
   first statement is `"use workflow"`.
2. The body's parameter type comes from jigs, never hand-rolled:
   `PipelineInputs<typeof inputs>` is the schema's output plus the `triggerId`
   the trigger injects, and `TicketPipelineInputs<typeof inputs>` adds the
   `issueId` and `identifier` it resolved a `ticket` input to — it takes only a
   schema with a required `ticket`, because that is the only case the trigger
   resolves. Both are on the `@salimhamed/jigs` root. Read the resolved pair;
   do not re-resolve the ticket in the body.
3. Register it in `jigs.config.ts` under the name `jigs run` will take, with its
   `requires` manifest.
4. Add its `workflow//./pipelines/<file>//<fn>` line to the factory's ids test.
5. `pnpm exec jigs build`, then `pnpm test`.

Determinism is a rule, not a fence: no clock, no `process.env`, no random in the
body. A step may read them, and its answer is memoized. Teardown is a plain last
line, never a `finally` — a suspension is a thrown error, and a parked run must
keep its worktree.

## Add a step

- **Wrapping something jigs ships**: a new `"use step"` function in the
  factory's `steps/jigs.ts` that delegates to the implementation, imported at
  module scope from `@salimhamed/jigs/steps`. Follow the shape already in that
  file.
- **A step of the factory's own**: a `"use step"` function in a factory-owned
  file under `steps/`, beside the pure helpers it uses.

Then `pnpm exec jigs build` and `pnpm test`. If this factory pins an exact id
list, add the new `step//./steps/<file>//<fn>` line to it; an id that
*changed* rather than appeared is a rename, and the fix is to restore the old
name, not to paste the new id in.

A block takes the wrappers it needs as plain parameters. Pass them as bare
identifiers and never reach one back off an object at the call site
(`options.readDiff(...)`): the SDK serializes a step call's receiver along
with its arguments, and that receiver would be an object holding functions.

## The requires manifest

`requires` on a pipeline entry is what preflight checks before a run is ever
created: `bindings` (names that must be declared, with a remote git can
reach), `harnesses` (`claude`, `codex` — each must be installed and logged in),
and `aws: true` (the service's AWS profile must resolve). Two credentials are
checked on every trigger whatever the manifest says: `LINEAR_API_KEY` and
`GITHUB_TOKEN`. A failed preflight means no run ever existed.

## Prompts, and the factory's voice

Agent-facing prose lives in the factory's `prompts/`, as TypeScript that
interpolates named values. jigs' own prompt strings are exported from
`@salimhamed/jigs/blocks` as plain values — read them, interpolate them, or
ignore them; a factory that wants different words writes its own and passes
them to the block.

The one the scaffold hands over outright is `describePr`: jigs owns the
mechanics (resume the builder, fall back to a fresh context fed the diff,
parse a `{ title, body }` back) and `prompts/describe-pr.ts` owns the
conventions, with `blocks/review-loop/describe-and-open-pr.ts` owning the
policy for an answer that drifts out of them — repair it, or throw and kill
the run. Whether that title has to satisfy the target repo's
CI is a factory question; look at how the two real factories answer it
differently before writing a third.

## Schedules

A recurring fire is declared in `jigs.config.ts` under `schedules`, keyed by its
own name: the pipeline it fires, a five-field cron read in the service host's
local time, and the static inputs to fire it with. Those inputs are typed
against the pipeline's schema, so a wrong field is a compile error. A tick whose
last run is still active is skipped; a tick missed while the service was down is
not made up. `pnpm exec jigs up` builds it and restarts the service onto what
it built, and `jigs ps` then lists it.

## After every change

```sh
pnpm typecheck
pnpm exec jigs build     # the ids test reads the build output, not the source
pnpm test
pnpm exec jigs up        # until this, the service still serves the old bundle
```

## Never

- Never run a standalone `npx workflow web` against a factory World. Opening
  that World starts a second queue worker, which steals the service's queue jobs
  and delivers them to a port with no workflow route. The service hosts the
  dashboard; use that.
- Never rename, move, or delete an exported wrapper in a factory's
  `steps/jigs.ts`, or a file under `pipelines/`, without the human's explicit
  instruction. Their names are half of the ids parked runs are memoized
  against, the build stays green while they are orphaned, and an orphaned run
  only ever shows up as stalled. Everything else in those files — bodies,
  order, prose, the factory's own blocks — is free to edit. When the human
  does want a rename, check `jigs ps` for parked runs first; cancel and
  relaunch the ones that would be orphaned.

## Confirm first

Ask the human before:

- `jigs cancel` — it releases every resource the run claims, and the run is over.
- `jigs sweep --force` — it deletes every eligible worktree without asking,
  dirty ones included.
- `jigs service restart` or `jigs service stop` while `jigs ps` shows a running
  or suspended run.
- Editing the `bindings` block in `jigs.yml`.
