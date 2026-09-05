# Author a pipeline

Everything you write here lives in the **factory repo**, not in the jigs
checkout. jigs ships steps; the factory owns every file that names them.

## Read first

- The factory's own `steps/jigs.ts` header, then its existing `pipelines/`.
- `CONTEXT.md` in the jigs checkout for the vocabulary — pipeline, jig, step,
  step id, binding, gate, needs-human halt, schedule.
- The worked examples, by path rather than from memory:
  - the smallest complete factory: `e2e/fixture-factory/` in the jigs checkout
    (`jigs.config.ts`, `pipelines/fixture.ts`, `steps/jigs.ts`).
  - if the `jigs-factory-js` factory is checked out on this machine, a real
    pipeline that needs no repo binding: its `pipelines/s3-bucket-analysis.ts`,
    with the factory-local steps in `steps/aws.ts`, the agent compositions in
    `steps/s3-diagnosis.ts`, and the prose in `prompts/`. If it is not checked
    out, lean on the fixture above — it carries the same shape at one pipeline.

## The three tiers, and why they matter

1. **A `"use step"` function owns a durable id** built from its file's path and
   its own name — `step//./steps/jigs//worktree`. That id is a memoization key
   in the factory's World. Its file path and its name are permanent.
2. **A jig is a plain composition** over those steps — `agent`, `ask`,
   `needsHuman`, `gate`, `ticketReview`, `reviewLoop`. No directive, no id.
   Renaming one is safe.
3. **A pure helper** is neither, carries no id, and is the easy thing to unit
   test.

A pipeline imports its steps from `../steps/jigs.ts`, **never** from
`@jigs/service` directly. A step reached through the package is addressed by
that package's version instead of by the factory's path, so every upgrade would
rename it. The factory's ids test is what catches this.

That ids test is a `jigs.config.test.ts` in the factory root: it reads the
emitted ids out of the last build, holds them as sorted arrays, and compares
exactly — the e2e fixture does the same job with a checked-in
`expected-ids.txt` and `e2e/check-step-ids.mjs`, because it has no test runner
of its own. If the factory you are in has no such test, write one before adding
anything: an unguarded rename is silent.

## Add a pipeline

1. A new file under `pipelines/`, exporting two things: a zod `inputs` schema
   (which doubles as the `--input` contract) and the pipeline function whose
   first statement is `"use workflow"`.
2. The body's parameter type is the schema's output **plus what the trigger
   injects**: `triggerId` always, and for a pipeline taking a `ticket` input,
   the resolved `issueId` and `identifier` beside it. Read them; do not
   re-resolve the ticket in the body.
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
  module scope. Follow the shape already in that file.
- **A step of the factory's own**: a `"use step"` function in a factory-owned
  file under `steps/`, beside the pure helpers it uses.

Either way, add the `step//./steps/<file>//<fn>` line to the ids test. The
arrays there are sorted and compared exactly, so a removed step fails until its
line goes too. An id that *changed* rather than appeared is a rename: restore
the old name — do not paste the new id in.

When a jig takes a deps object, destructure it before calling
(`const { agent } = deps;`). The SDK serializes a step call's receiver along
with its arguments, and a deps object holds functions.

## The requires manifest

`requires` on a pipeline entry is what preflight checks before a run is ever
created: `bindings` (names that must be declared, with a remote git can
reach), `harnesses` (`claude`, `codex` — each must be installed and logged in),
and `aws: true` (the service's AWS profile must resolve). Two credentials are
checked on every trigger whatever the manifest says: `LINEAR_API_KEY` and
`GITHUB_TOKEN`. A failed preflight means no run ever existed.

## Prompts, and the factory's voice

Agent-facing prose lives in the factory's `prompts/`, as TypeScript that
interpolates named values. Two things jigs ships no default for and every
factory must write: those prompts, and `describePr` — the `reviewLoop` dep that
turns a finished change into the pull request's title and body. Whether that
title has to satisfy the target repo's CI is a factory question; look at how the
two real factories answer it differently before writing a third.

## Schedules

A recurring fire is declared in `jigs.config.ts` under `schedules`, keyed by its
own name: the pipeline it fires, a five-field cron read in the service host's
local time, and the static inputs to fire it with. Those inputs are typed
against the pipeline's schema, so a wrong field is a compile error. A tick whose
last run is still active is skipped; a tick missed while the service was down is
not made up. `pnpm exec jigs build` then `jigs service restart` to pick it up,
and `jigs ps` then lists it.

## After every change

```sh
pnpm typecheck
pnpm exec jigs build     # the ids test reads the build output, not the source
pnpm test
```

`jigs build` warns when a run is still in flight: a pipeline that changed shape
no longer answers to the step ids its parked run was memoized under.

## Never

- Never run a standalone `npx workflow web` against a factory World. Opening
  that World starts a second queue worker, which steals the service's queue jobs
  and delivers them to a port with no workflow route. The service hosts the
  dashboard; use that.
- Never rename, move, or delete an exported function in a factory's
  `steps/jigs.ts`, or a file under `pipelines/`, without the human's explicit
  instruction. Those names are the memoization keys of every parked run, and the
  build stays green while they are orphaned.

## Confirm first

Ask the human before:

- `jigs cancel` — it releases every resource the run claims, and the run is over.
- `jigs sweep --force` — it deletes every eligible worktree without asking,
  dirty ones included.
- `jigs service restart` or `jigs service stop` while `jigs ps` shows a running
  or suspended run.
- Editing the `bindings` block in `jigs.yml`.
