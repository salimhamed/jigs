# The source layout follows the three kinds of code, and the folders are the import paths

`packages/jigs/src` is split by what the Workflow SDK does with the code, not
by feature. There are three kinds, and each gets a top level folder:

- `blocks/` is pipeline-side code. It runs on every replay and must do nothing
  on its own.
- `steps/` is step implementations. Each one runs once and its result is
  recorded.
- `service/` is the long-running process. It never runs inside a pipeline.

Two of those folders are the public import paths: `@salimhamed/jigs/blocks`
and `@salimhamed/jigs/steps`. The service paths the build uses stay as they
were. Decided by Salim on 2026-09-11, shipped in 0.5.0.

## Why the runtime forces this

The SDK runs a pipeline by **replay**. On every wake it calls the pipeline
function again from the first line, and any step that already has a recorded
result returns that record instead of running. So the pipeline function runs
many times for one run, and each step inside it runs once.

Two rules follow. Code that runs inside a pipeline must have no effects of its
own: no git, no network, no filesystem, no `process.env`. It is also bundled
into a sandbox with no Node built-ins, so those calls would not resolve
anyway. Code that does real work has to be a step, so the SDK can run it once
and record the answer.

The service is neither. It is the process that hosts the compiled pipelines,
receives webhooks, fires schedules and serves the dashboard
([ADR 0012](./0012-per-factory-service.md)).

Before 0.5.0 jigs mixed all three kinds in the same folders and held the line
with header comments on three files: `src/index.ts`, `src/steps/index.ts` and
`src/worktrees/facts.ts`. A comment is not a boundary. Six files held both a
pipeline-side half and a step half in one module, so the only thing stopping a
`node:` import from reaching the pipeline bundle was whoever read the comment
last.

## The layout

```
blocks/      pipeline-side.
  agent/          how a pipeline calls an agent
  builder-agent/  the moves the builder agent makes
  ticket/         claim, ticket review, snapshot shaping, the halt for a human
  pull-request/   the gate, attend, review answers
  factory.ts      the types a factory declares its pipelines with
  worktree.ts     the WorktreeFacts type a pipeline passes around
steps/       step implementations.
  agent/          run an agent or a plain model call, and the worktree lock
  ticket/         fetch a snapshot, post and read Linear comments, issues
  pull-request/   branch state, push, open, comment, reply, squash merge
  worktree/       provision, create, clone, tear down, registry, sweep
service/     app, routes, ingress, schedules, readiness, shutdown, nitro, build
cli/         the `jigs` command
checks/      requirement checks, shared by preflight, doctor and steps
providers/   raw clients with no jigs knowledge: git, GitHub, Linear
config/      the factory's config file, root, environment and paths
errors.ts
```

The import rules are one sentence each.

- `blocks/` may import other `blocks/` files, zod, the `workflow` SDK, and
  `import type` from anywhere. It may not import a **value** from a node
  built-in, read the environment, reach the network, or import a value from
  `steps/`, `service/`, `cli/`, `checks/`, `config/` or `providers/`. A type
  erases at compile time, so a type import crosses no boundary; `gate.ts`
  naming GitHub's `ReviewThread` and `answers.ts` naming the step signatures
  it is handed are both that.
- `steps/` may import `providers/`, `config/`, `checks/`, `errors.ts`, and
  types from `blocks/`.
- `service/` may import `steps/`, `providers/`, `config/` and `checks/`.

Six mixed files were split along that line. The three that mattered were the
needs-human halt, the pull request gate and the ticket snapshot: each had a
block half that decides and a step half that talks to Linear or GitHub, and
each is now two files in two folders.

**Where a type goes.** A type used by one module stays in that module. A type
used on both sides of the blocks/steps line lives in `blocks/`, under the same
topic. `WorktreeFacts` is the example that already existed. There is no shared
types folder, because a shared types folder is where the rule goes to die.

**Where a prompt goes.** Beside the code that uses it, as
`<name>.prompt.ts`. Prompts are pure strings, so they are pipeline-side by
nature, and they are still exported so a factory can read one or pass its own
([ADR 0018](./0018-blocks-not-loops.md)). The old `src/prompts/` folder is
gone.

**Where `github-webhook.ts` went.** It stayed in `providers/`. It combines the
GitHub API with jigs' own paths and config, so it could have gone to
`steps/pull-request/` instead. It is in `providers/` because only the service
ingress calls it, never a step and never a block, and `providers/` is what the
service reaches for a raw client. If a step ever needs it, it moves.

## The four words

The vocabulary this layout is named in is four words, and they chain in one
direction.

- **Pipeline**: a whole process, one file, started by `jigs run`.
- **Block**: pipeline-side reusable code that calls steps in a fixed way,
  whether jigs ships it or the factory writes it.
- **Step wrapper**: the factory's `"use step"` function around a step. It gives
  the step its durable id.
- **Step**: the function that does the work.

A pipeline calls blocks and wrappers. A block calls wrappers. A wrapper calls a
step. The SDK's two markers live only in the factory: `"use workflow"` on each
pipeline, `"use step"` on each wrapper. No file in this repo carries either
([ADR 0013](./0013-factory-owned-steps.md)), so everything between the two
markers, jigs blocks and factory blocks alike, is plain code pulled into the
pipeline bundle because the pipeline imports it.

## What enforcement there is

Three things, and none of them is a lint rule.

1. The folders, which make a wrong import visible in a diff.
2. The exports map, which points `./blocks` and `./steps` at those folders, so
   a factory cannot reach a step implementation through the blocks path.
3. `pnpm e2e`, which builds the scaffolded factory and scans the emitted
   workflow bundle for `node:` specifiers and for `process.env`. Either one is
   a failure.

A lint rule and a separate `tsconfig.json` for `blocks/` were both considered
and deliberately deferred. The bundle scan catches the failure that actually
costs something, which is a node built-in or an environment read reaching the
sandbox, and it catches it whatever route the import took.

## Consequences

- **The public surface is named by kind.** The exports map is the root,
  `./blocks`, `./steps`, and the service paths. Gone: `./checks`,
  `./harnesses`, `./prompts`, `./steps/jit`, `./steps/run`, `./suspension/*`,
  `./ticket/*`, `./review-loop`, `./review-loop/pull-request`, `./worktrees`
  and `./providers/linear`. That is a breaking change, released as 0.5.0
  ([ADR 0017](./0017-single-package.md)).
- **The scaffold follows the same split.** A factory gets `steps/jigs.ts`
  holding only `"use step"` wrappers, `blocks/jigs.ts` holding the jigs blocks
  bound to those wrappers, and `blocks/review-loop/` holding its own process,
  one decision per file.
- **No step id moved for a layout reason.** Ids are factory local paths
  ([ADR 0013](./0013-factory-owned-steps.md)), so moving a file inside this
  package cannot address one. 0.5.0 did move ids, but because it renamed three
  wrappers and split a fourth, which is a separate decision recorded in
  `e2e/expected-ids.txt`.
- **A file that wants to be in two folders is a file that wants to be split.**
  That is the rule the six mixed files produced, and it is the one to apply
  next time.

## Considered options

- **Split by feature**, keeping `ticket/`, `worktrees/`, `review-loop/` as top
  level folders and marking the kind some other way. Rejected: that is the
  layout that produced the six mixed files. Feature is the second axis here,
  and it is where it belongs, one level down inside `blocks/` and `steps/`.
- **A lint rule on `blocks/` imports.** Deferred rather than rejected. It would
  catch a wrong import earlier than the e2e does, and it is worth adding when
  someone actually makes the mistake. It is not what the boundary rests on.
- **A separate `tsconfig.json` for `blocks/` with no node types.** Deferred for
  the same reason, and it costs more: a second project reference, a second
  build step, and editor setup that has to agree with both.
- **A shared `types/` folder** for anything both sides name. Rejected. It grows
  without bound, it hides which side owns a type, and the one type that
  actually crossed the line had already found a good home in `blocks/`.
