# jigs

[![npm](https://img.shields.io/npm/v/@jigs-ai/jigs)](https://www.npmjs.com/package/@jigs-ai/jigs)

> In manufacturing, a jig guides tools through repeatable operations.

jigs runs durable TypeScript workflows that combine agents, model calls, and
external operations. Use it to deliver software, investigate infrastructure,
or automate another repeatable process. Factories own the process and policy.

Documentation: <https://salimhamed.github.io/jigs/>

## How it fits together

- Your workflows live in a **factory repo**, one per person, scaffolded by `jigs init`.
- `jigs build` compiles that factory's workflows into a **service** of its own,
  backed by its own Postgres **World** on its own port.
- `jigs run` creates a run, and the service executes it with coding agents in git
  worktrees **cut from jigs' own clone of the target repo**.
- The **dashboard** the service hosts shows every run's full step history.
- **Schedules** declared in the factory fire workflows on a cron tick.
- The optional ship recipe moves its ticket as work starts, a pull request opens,
  and the delivery merges or stops.

## Quick start

jigs ships as one package on npm, `@jigs-ai/jigs`: the CLI, and the library a
factory is written against (`pnpm add @jigs-ai/jigs` or `npm i @jigs-ai/jigs`).
A factory pins it to a
version and runs its own copy of the CLI; nothing is installed globally and
nothing is cloned, and no registry token is needed. Expect around ten minutes.

**Prerequisites.**

- Node 24 or newer, and pnpm.
- Docker, with the daemon running.
- The coding-agent CLIs your workflows will drive — `claude` and `codex` — each
  logged in to its subscription. Install both yourself and keep them on the
  `PATH` of whatever starts the service; it will not start without them.
- If node comes from a version manager, the shell you start the service from
  needs it on `PATH`.

### 1. Scaffold a factory

```sh
mkdir my-factory && cd my-factory && git init
pnpm dlx @jigs-ai/jigs init
```

`jigs init` writes files and runs nothing: `jigs.config.ts`, `package.json` pinned to
the version that scaffolded it, `nitro.config.ts`, `docker-compose.yml`,
`.env.example`, the build config — and the code the factory starts from. Then
it prints the remaining steps with **your** ports filled in. Use its numbers,
not the ones below.

### 2. Read the factory's own code

The factory separates its configuration, generated integration, and custom code:

- `jigs.config.ts` declares service ports, bindings, deferred workflow imports,
  schedules, the GitHub and Linear identities jigs runs as, and this factory's
  merge policy.
  Workflow modules export their function, inputs and requirements together.
- `jigs.ts` is generated, committed integration code: named durable step wrappers
  and ready-to-call jigs blocks. Never put custom code here. `jigs generate`
  refreshes it from the installed library; `jigs build` reports stale code.
- `workflows/hello.ts` creates and removes a run directory, then returns its input.
  It needs no repository binding or integration credentials.
- `blocks/` holds factory-specific prompts, ticket acquisition, and domain decisions.
- The optional ship recipe supplies factory-owned delivery phases, prompts, and tests.
- `steps/` holds any custom durable operations a factory adds.
- Prompts are typed functions beside the code that uses them. Pass a prompt
  override to a block; keep shared factory defaults in a custom block.

Factory code names all of it from the project root — `#jigs`, `#blocks/…`,
`#steps/…` — through the `imports` map in the factory's `package.json`, so a
file's depth never changes how it reaches another.

Start with the bound blocks in `jigs.ts`: `runAgent` runs an agent with tools,
`askModel` makes a plain model call, and `haltForHuman` asks for help and waits
for a reply. Their JSDoc explains when to use them. The durable wrappers use
explicit parameter names and the library's named types; every wrapper and its
implementation carry the same name, so `steps.executeAgent` does the work for
`executeAgent` and `steps.openPullRequest` for `openPullRequest`.
For committed Git changes, call `readChange(worktreePath, base)` from `#jigs`.
It resolves `base` and `HEAD` once, compares their trees directly, and returns
file statuses, per-file line counts, and commits reachable from head but not
base. It returns at most 1,000 files and 1,000 commits; `truncated` means some
results were omitted. Binary files contribute zero line counts.
Pass the returned `base` and `head` to `readPatch(worktreePath, base, head, paths)`
to inspect named files from that same change. Paths are literal, not globs;
empty paths are rejected. Patch text shares a 200,000-character budget across
files, with its own `truncated` flag. `renderChangeSummary` from
`@jigs-ai/jigs/blocks/git` renders the summary and displays at most 60 file rows,
with an “and N more” tail for the remaining rows.

Wrappers pass run metadata to jigs, which handles run-specific details such as
dashboard links. The service automatically releases a terminal run's eligible
managed-local resources under
`release: { onSuccess: "release", onFailure: "keep" }` by default. A workflow's
entry can override the factory's policy. `failed` and `cancelled` both use
`onFailure`; suspended runs keep everything. Call `await release()` from `#jigs`
as the last successful workflow action when the workflow needs the report
before returning. An explicit `release(policy)` argument is persisted and wins
over later automatic cleanup, including an explicit `keep`.
Dirty unmerged work stays; a branch is deleted only with positive evidence that
the remote default branch contains its commits. Squash-merged branch refs may
therefore remain. Failed cleanup is visible in `jigs status <run-id>` and retried by the
service; `jigs resources list` and preview-first `jigs resources prune` are the
explicit maintenance path. Never put
release in `finally` or a catch: waiting throws too.

Both workflow and step function paths and names contribute to durable IDs.
Renames are supported breaking changes: finish or cancel affected active runs
before deploying them. Ordinary library version bumps do not change these IDs.

### 3. Start the service

```sh
cp .env.example .env      # configure credentials when a workflow needs them
pnpm install              # puts the factory's own jigs in node_modules/.bin
pnpm exec jigs up --no-doctor
```

For bare hello setup, `--no-doctor` skips the final doctor pass, which checks
GitHub credentials even when the workflow does not use GitHub. Postgres and the
service's machine prerequisites (including both agent CLIs) still apply. Once
integration credentials are configured, use plain `jigs up` and `jigs doctor`.


`GITHUB_TOKEN` is the credential of the default `pat` identity, where jigs acts
as you. `jigs init --github-identity-mode app` scaffolds the other one, where jigs acts as
a GitHub App and you can approve the pull requests it opens; it needs an App
registration and its private key instead, and no `GITHUB_TOKEN`. Linear works
the same way: the default `key` identity reads `LINEAR_API_KEY` and acts as
you, and `jigs init --linear-identity-mode app` makes jigs a Linear OAuth app
that reads `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, so its mentions
reach your inbox. All of them, and the merge policy beside them, are in
[setup](docs/setup.md).

`jigs up` takes the factory from whatever state it is in to a running service:
install, Postgres World, migrations, build, start and wait until the service
is ready, then `jigs doctor`. One line per step, and it stops at the first that
fails with the repair on the next line. Re-run it after any change — an
unchanged factory installs, migrates and restarts nothing.

From here every `jigs` is the factory's own: `pnpm exec jigs …` (or
`pnpm jigs …`).

### 4. Add a recipe when you want a process

`jigs init` starts bare. To adopt the ship process, copy the recipe:

```sh
pnpm exec jigs recipe list
pnpm exec jigs recipe add ship
```

The command reports created and kept files, preserving existing code. It prints
this line to add manually under `workflows` in `jigs.config.ts`:

```ts
ship: () => import("./workflows/ship.ts"),
```

The copied workflow, tests, and Linear block become factory code. Edit them
freely; upgrades do not overwrite them. Ship needs Linear/GitHub credentials
and its agent harnesses. Bind a target repository before running it:

```sh
pnpm exec jigs bind git@github.com:owner/repo.git
pnpm exec jigs doctor # reports repository settings that need attention
pnpm exec jigs up
```

A **binding** maps a name to a target repo's remote URL and worktree provisioning
settings. jigs keeps a clone per binding and creates agent worktrees from it.
The service prepares those clones when it starts. Run `jigs up` after editing
configuration; it rebuilds and restarts when the configuration changes.

`jigs bind` edits a literal `bindings` object in `jigs.config.ts` using the
TypeScript syntax tree. Without `--binding-name`, an existing binding with the exact
remote URL is reused; otherwise its name comes from the repo name. An explicit
`--binding-name` bypasses that match and can create another binding for the same remote.
Unsupported expressions produce a clear error before any file or webhook
changes; those configurations can be edited manually.

### 5. Run

```sh
pnpm exec jigs run hello --input message=hello
# After adding ship and configuring its integrations:
pnpm exec jigs run ship --input ticket=AGE-123 --input binding=repo
pnpm exec jigs workflows
pnpm exec jigs status
pnpm exec jigs status <run-id>
pnpm exec jigs watch [run-id]
```

`<run-id>` may be a complete run ID, a unique prefix, or the ticket the run
claimed (`AGE-123` or its supported UUID). `jigs workflows` lists the launch
names actually registered in the running factory and the input metadata their
existing schemas provide.

`jigs status` names each run's ticket, status, trigger, how long since it last moved
and, for a parked run, what it is waiting for and the link to act on.
`jigs status <run-id>` says the same for one run and adds the question
a halt asked. For a run parked on a pull request it reads GitHub as well and
prints the head commit, CI, approval, draft and mergeable state, what is
blocking the merge, and when the service last woke the run. `jigs status` and
`jigs watch` never read GitHub.
It also lists the run's recorded resources as kind, identity and URL. Resources
come from run attributes, independently of the workflow's return value; a run
without any says `resources none`. `--json` returns the same records in a
`resources` array.
Generated worktree and run-directory steps register their local resources. The
ship recipe also registers GitHub branches when it pushes them and pull requests
after creation.
`jigs watch` is one long-lived process that follows every run in
the factory, a line per step, suspension, resume, terminal state and new run.
Pass a selector to follow only that run.
Both forms of `jigs status` take `--json`; `jigs watch --json` emits one JSON
event per line with or without a selector.

### Upgrading later

```sh
pnpm exec jigs upgrade
```

normalizes jigs' release-age exclusion, then bumps jigs to the latest release
(`--to-version <version>` pins it) and runs `jigs up`. During that `up`, it installs
the release, regenerates `jigs.ts` through the installed CLI, then builds and
starts the factory. Finally it typechecks the factory. Review and commit the
regenerated `jigs.ts` and any `pnpm-workspace.yaml` normalization. Custom code
is never generated.

## Factory control

Run `jigs recipe add ship`, then edit the copied code. See
[the ship recipe guide](docs/delivery.md) for role/model selection, budgets,
prompt overrides, custom ticket sources, and composing individual phases. Generic
agent workflows use the same core without adopting any delivery concepts.

### Register resources from custom workflows

The generated `registerResource` step records any resource kind without adding
provider policy to jigs:

```ts
import { registerResource } from "#jigs";

await registerResource({
  kind: "s3-report",
  identity: "quarterly/2026-Q3",
  url: "https://reports.example.com/quarterly/2026-Q3",
});
```

Kind plus identity is the stable identity. Repeating the same record is
idempotent; registering a different URL for that identity replaces its URL.
If two writers update the same identity concurrently, the last committed
attribute event wins. Use distinct identities when both resources must remain.
Each distinct identity uses one SDK run attribute, so concurrent registrations
compose. The Workflow SDK permits 64 attributes per run, including unrelated
and reserved attributes, keys up to 256 characters, and values up to 256 UTF-8
bytes. jigs reports the exact limit and never truncates an identity or URL.

When resource creation is an external write that is not itself idempotent, put
creation and registration in separate durable steps: await the creator first,
then call `registerResource`. A retry reuses the recorded creator result and
retries only registration. Inside an idempotent custom `"use step"` function,
the same implementation is available as `registerResource` from
`@jigs-ai/jigs/steps/runtime`.

A registration is an observability record. It grants no permission to delete
the resource. Cleanup must separately recognize a managed local kind and apply
that kind's own policy; an arbitrary custom URL is never deletion authority.

## The `/jigs` skill

```sh
npx skills add salimhamed/jigs
```

installs a skill your coding agent can run as `/jigs`. It takes a plain-language
argument and routes it to one of four guides:

- **operate** — run, watch, diagnose, cancel or inspect resources; answer a halt waiting on a
  human.
- **author** — write a workflow, a step, a prompt, a schedule, or a `requires`
  manifest.
- **setup** — from nothing to a first run.
- **ask** — answer a question about jigs, and change nothing.

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. Every term above is defined there.
- [Documentation](https://salimhamed.github.io/jigs/) — get started, build workflows, and browse the API for the latest stable release.
- [`docs/setup.md`](docs/setup.md) — the full runbook.
- [`docs/adr/`](docs/adr/) — one file per decision.

## Layout

jigs is one root package, published as `@jigs-ai/jigs`. `src/` contains
its implementation, `templates/` contains the bare factory scaffold, and
`recipes/` contains optional workflows copied into factories.
`pnpm-workspace.yaml` holds dependency build permissions; there are no workspace members.

### Four words

The rest of this section is written in four terms, so they come first.

- **Workflow**: a whole process, one file, started by `jigs run`.
- **Block**: reusable code that runs inside a workflow and calls steps in a
  fixed way. jigs ships blocks and a factory writes its own; both are plain
  code with no directive and no id.
- **Step wrapper**: the factory's `"use step"` function around a step. Its
  file path and its name are the step's durable id.
- **Step**: a durable operation whose result the SDK records. The library
  supplies its implementation; the factory wrapper gives it a durable address.

A workflow calls blocks and durable step wrappers. A wrapper delegates to the
operation’s implementation; custom factory steps can implement that work directly.

### The three kinds of code, and why the runtime forces the split

A workflow is one whole process written as one function, and the Workflow SDK
runs it by **replay**. Replay means this: every time a run wakes up, the SDK
calls the workflow function again from its first line. Any step that already
has a recorded result does not run again; the SDK returns the record. So the
workflow function itself runs many times over the life of one run, and the
completed step calls return their recorded results. Failed attempts can be
retried, so external operations must still account for retries.

Two consequences follow, and they are the whole reason for the folder layout.

1. Code that runs inside a workflow — the workflow and every block it calls —
   must keep its own operations replay-safe. No git, network, filesystem or reading
   `process.env`. If it did, it would do it again on every wake. It is also
   bundled into a sandbox with no Node built-ins, so those calls would not
   resolve anyway.
2. Code that does real work has to be a step, so that the SDK can track attempts and
   record its result.

There is a third kind that is neither. The **service** is the long-running
process a factory builds and starts: the poll that wakes parked runs, the
optional webhook routes, the scheduler, the run endpoints and the dashboard.
It never runs inside a workflow at all.

What goes into that sandboxed bundle is decided by the two Workflow SDK
markers, and both live in factory code (including copied recipes): `"use workflow"` on each workflow,
`"use step"` on each wrapper. No library file under `src/` carries either: a directive
in the library would put this package's version inside every durable step id, and bumping
it would orphan parked runs. Everything between the two
markers, jigs blocks and factory blocks alike, is plain code that gets pulled
into the bundle because the workflow imports it — which is why a single stray
`node:` import in a block would land there.

jigs used to mix all three kinds in the same folders and hold the line with
header comments on three files. Since 0.5.0 the folders are the line, and the
folders are the public import paths.

### The src tree

```
src/
  blocks/                replay-safe orchestration and shared domain shapes
    agents/              agent/model calls, harness configuration and sessions
    human/               provider-neutral question and option schemas
    linear/              ticket claims, clarification and human-input transport
    pull-requests/       GitHub gates, review answers and comment markers
    workspaces/          Git worktree facts
    git/                 change summaries and patch shapes
    runtime/             explicit run release and control-flow helpers
    factory.ts           factory/workflow configuration types
  steps/                 effectful implementations, under the same seven topics
    agents/              agent and model execution
    human/               reserved topic; no provider-neutral execution yet
    linear/              Linear snapshots, issues and comments
    pull-requests/       GitHub API operations
    workspaces/          worktree provisioning, registry and teardown mechanics
    git/                 local branch state, pushes, diffs and patches
    runtime/             run directories, run context and release operations
  service/               app, routes, ingress, schedules, readiness and shutdown
  cli/                   commands and subcommands
  checks/                preflight, doctor and just-in-time requirement checks
  providers/             raw Git, GitHub and Linear clients
  config/                factory config, root, environment and paths
  run-status.ts          private terminal-state classification
  run-suspension.ts      private run-wait inspection
```

One rule decides where a type goes: a type used by one module stays in that
module, and a type used on both sides of the blocks/steps line lives in
`blocks/`, under the same topic. There is no shared types folder.

Prompts sit beside the code that uses them, as `<name>.prompt.ts`. They are
still exported, so a factory can read one or pass its own instead.

### Import paths

Import by code kind, then topic: `@jigs-ai/jigs/blocks/<topic>` for
workflow-side code and `@jigs-ai/jigs/steps/<topic>` for implementations
called inside factory `"use step"` wrappers. The topics are `agents`, `human`,
`linear`, `pull-requests`, `workspaces`, `git` and `runtime`; folders match them.
Blocks stay free of Node built-ins, environment reads and network calls.
Generated `jigs.ts` imports each operation from its topic and keeps the durable
wrapper names stable. Workflows normally call those wrappers through `#jigs`.

`human` holds provider-neutral question/option schemas and JSON prompt values.
The current halt, comment-shaped reply, ticket claim and reply checking remain
in `linear`: separating that transport requires a future API design. Accordingly,
`steps/human` currently exports no operations. Run status and suspension inspection
remain private service/CLI implementation details.

The package root, `@jigs-ai/jigs`, keeps factory configuration, `WorkflowEntry`,
`defineFactory`, `ticketInputSchema`, `JigsError` and its existing shared types.
Flat topic aliases and catch-all block/step paths have been removed.

The remaining subpaths belong to the service the factory builds:
`@jigs-ai/jigs/app`, `/nitro`, `/schedules`, `/build`,
`/plugins/start-world` and `/plugins/start-dashboard`. A factory names
`/nitro` in its `nitro.config.ts`; `jigs build` and the server entry it
generates name the rest.

The package ships compiled, from `dist/`, one entry per export subpath. The
Workflow SDK, its Postgres World, its dashboard and zod are peers the factory
installs itself, so a factory pins one copy of each and the CLI stays
installable with `pnpm dlx` before any of them exist.

## Development

Requires Node 24 or newer and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build
pnpm docs:site  # build the guides and API website in docs-site/
pnpm docs:preview # preview the built website locally
pnpm e2e        # bare + ship factories, packed installs, two versions each, diff ids
                # (with WORKFLOW_POSTGRES_URL set: boot the service and stop it too)
pnpm test:live   # live tests (requires their documented provider/auth setup)
```

For local e2e or live-test environment values, copy `.env.e2e.example` to
`.env.e2e.local`. The local file is gitignored. E2e Postgres must use a
dedicated database and port; do not point it at a live factory World or a
database used by another application. Values supplied explicitly in the shell
or CI take precedence over values in the local file.

Biome formats code with a line width of 100 characters. Keep the generated
`jigs.ts` template formatted the same way so formatting a factory does not make
its integration appear stale.

A merge to `main` with a releasable title opens or updates the release PR;
its merge tags the release and publishes to npm. The
[setup runbook](docs/setup.md#part-1--the-machine-once) has the repository
settings that make it work.
