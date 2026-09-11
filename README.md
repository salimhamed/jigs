# jigs

> In manufacturing, a jig guides tools through repeatable operations.

jigs lets you write a repeatable piece of development work — take this ticket,
implement it, review it, open the pull request — once, then have coding agents
run it for you whenever you want.

## How it fits together

- Your pipelines live in a **factory repo**, one per person, scaffolded by `jigs init`.
- `jigs build` compiles that factory's pipelines into a **service** of its own,
  backed by its own Postgres **World** on its own port.
- `jigs run` creates a run, and the service executes it with coding agents in git
  worktrees **cut from jigs' own clone of the target repo**.
- The **dashboard** the service hosts shows every run's full step history.
- **Schedules** declared in the factory fire pipelines on a cron tick.

## Quick start

jigs ships as one package on GitHub Packages, `@salimhamed/jigs`: the CLI, and
the library a factory is written against. A factory pins it to a version and
runs its own copy of the CLI; nothing is installed globally and nothing is
cloned. Expect around ten minutes.

**Prerequisites.**

- Node 24 or newer, and pnpm.
- Docker, with the daemon running.
- The coding-agent CLIs your pipelines will drive — `claude` and `codex` — each
  logged in to its subscription.
- A GitHub **classic** personal access token with `read:packages` and, while
  this repo is private, `repo`. Fine-grained tokens cannot read GitHub
  Packages.
- If node comes from a version manager, the shell you start the service from
  needs it on `PATH`.

### 1. Point pnpm at GitHub Packages (once per machine)

```sh
cat >> ~/.npmrc <<'EOF'
@salimhamed:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_your_token_here
EOF
```

The first line routes the `@salimhamed` scope; the second is the token that
reads it. The same two lines serve `pnpm dlx`, `pnpm install` and every
`jigs upgrade` from here on. The factory's own `.npmrc` carries only the scope
line, so the token never lands in a repo.

### 2. Scaffold a factory

```sh
mkdir my-factory && cd my-factory && git init
pnpm dlx @salimhamed/jigs init
```

`jigs init` writes files and runs nothing: `jigs.yml`, `package.json` pinned to
the version that scaffolded it, `nitro.config.ts`, `docker-compose.yml`,
`.env.example`, the build config — and the code the factory starts from. Then
it prints the remaining steps with **your** ports filled in. Use its numbers,
not the ones below.

### 3. Read the factory's own code

Everything `jigs init` wrote is yours now: it never rewrites a file that
exists. These are the code `jigs build` compiles:

- `jigs.config.ts` is this factory's pipelines, keyed by the name `jigs run`
  takes.
- `pipelines/ship.ts` is the starter pipeline: a ticket to a merged pull
  request.
- `steps/jigs.ts` holds this factory's `"use step"` wrappers around the steps
  jigs ships, and nothing else.
- `blocks/jigs.ts` holds the jigs blocks this factory uses, bound to those
  wrappers.
- `blocks/review-loop/` is this factory's own review loop, one decision per
  file: the story in `review-loop.ts`, and beside it the push, the
  description, the answer to a review, the CI bound and the merge policy.
- `prompts/describe-pr.ts` holds the words a pull request introduces itself
  with.

Edit all of it. The one rule: an exported wrapper's name and its file's path
are its durable step id, so renaming or moving one changes that id — do it
only when `jigs ps` shows no parked runs. A run whose id moved under it shows
up stalled; cancel it and relaunch.

### 4. Tokens, then up

```sh
cp .env.example .env      # fill in LINEAR_API_KEY and GITHUB_TOKEN
pnpm install              # puts the factory's own jigs in node_modules/.bin
pnpm exec jigs up
```

`jigs up` takes the factory from whatever state it is in to a running service:
install, Postgres World, migrations, build, start and wait until the service
is ready, then `jigs doctor`. One line per step, and it stops at the first that
fails with the repair on the next line. Re-run it after any change — an
unchanged factory installs, migrates and restarts nothing.

From here every `jigs` is the factory's own: `pnpm exec jigs …` (or
`pnpm jigs …`).

### 5. Bind a target repo

```sh
pnpm exec jigs bind git@github.com:owner/repo.git
pnpm exec jigs up --restart
```

A **binding** maps a name to a target repo's remote URL plus how its worktrees
are provisioned; jigs keeps its own clone per binding and cuts agent worktrees
from it. The service makes the clones when it starts, and a binding is no
change to the bundle, so `--restart` is what asks `jigs up` for the restart it
would otherwise skip.

### 6. Run

```sh
pnpm exec jigs run <pipeline> --input ticket=AGE-123
pnpm exec jigs ps
pnpm exec jigs logs <run>
```

`<run>` is a run id, a unique prefix of one, or the ticket the run claimed.
`jigs logs` prints the run's page on the dashboard `jigs up` named.

### Upgrading later

```sh
pnpm exec jigs upgrade
```

bumps jigs to the latest release (`--to <version>` pins it), runs
`jigs up`, then the factory's typecheck — which names any wrapper a release
asks `steps/jigs.ts` to grow.

## The `/jigs` skill

```sh
npx skills add salimhamed/jigs
```

installs a skill your coding agent can run as `/jigs`. It takes a plain-language
argument and routes it to one of four guides:

- **operate** — run, watch, diagnose, cancel or sweep; answer a halt waiting on a
  human.
- **author** — write a pipeline, a step, a prompt, a schedule, or a `requires`
  manifest.
- **setup** — from nothing to a first run.
- **ask** — answer a question about jigs, and change nothing.

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. Every term above is defined there.
- [`docs/setup.md`](docs/setup.md) — the full runbook.
- [`docs/adr/`](docs/adr/) — one file per decision.

## Layout

jigs is a pnpm workspace with one published package, `packages/jigs`, which
publishes as `@salimhamed/jigs`. Under `packages/jigs/templates/` sits
everything `jigs init` writes into a new factory, one `.tmpl` file per
scaffolded file.

### Four words

The rest of this section is written in four terms, so they come first.

- **Pipeline**: a whole process, one file, started by `jigs run`.
- **Block**: reusable code that runs inside a pipeline and calls steps in a
  fixed way. jigs ships blocks and a factory writes its own; both are plain
  code with no directive and no id.
- **Step wrapper**: the factory's `"use step"` function around a step. Its
  file path and its name are the step's durable id.
- **Step**: the function that does the work.

They chain in one direction. A pipeline calls blocks and wrappers. A block
calls wrappers. A wrapper calls a step.

### The three kinds of code, and why the runtime forces the split

A pipeline is one whole process written as one function, and the Workflow SDK
runs it by **replay**. Replay means this: every time a run wakes up, the SDK
calls the pipeline function again from its first line. Any step that already
has a recorded result does not run again; the SDK returns the record. So the
pipeline function itself runs many times over the life of one run, and the
steps inside it run once each.

Two consequences follow, and they are the whole reason for the folder layout.

1. Code that runs inside a pipeline — the pipeline and every block it calls —
   must do nothing on its own. No git, no network, no filesystem, no reading
   `process.env`. If it did, it would do it again on every wake. It is also
   bundled into a sandbox with no Node built-ins, so those calls would not
   resolve anyway.
2. Code that does real work has to be a step, so that the SDK runs it once and
   records what it returned.

There is a third kind that is neither. The **service** is the long-running
process a factory builds and starts: the webhook routes, the scheduler, the
run endpoints and the dashboard. It never runs inside a pipeline at all.

What goes into that sandboxed bundle is decided by the two Workflow SDK
markers, and both live only in the factory: `"use workflow"` on each pipeline,
`"use step"` on each wrapper. No file in this repo carries either
([ADR 0013](docs/adr/0013-factory-owned-steps.md)). Everything between the two
markers, jigs blocks and factory blocks alike, is plain code that gets pulled
into the bundle because the pipeline imports it — which is why a single stray
`node:` import in a block would land there.

jigs used to mix all three kinds in the same folders and hold the line with
header comments on three files. Since 0.5.0 the folders are the line, and the
folders are the public import paths.

### The src tree

```
packages/jigs/src/
  blocks/      pipeline-side code: the blocks a pipeline calls.
               May import other blocks, zod, the workflow SDK, and `import
               type` from anywhere. May not import a value from a node
               built-in, the environment, the network, or steps/, service/,
               cli/, checks/, config/ or providers/.
    agent/          how a pipeline calls an agent
    builder-agent/  the moves the builder agent makes: implement, answer a
                    review, fix CI, commit work, describe a PR
    ticket/         claim a ticket, review it, shape its snapshot, and halt
                    the run for a human
    pull-request/   the pull request gate, waiting on it, and the answers
                    posted back to it
    factory.ts      the types a factory declares its pipelines with
    worktree.ts     the WorktreeFacts type a pipeline passes around
  steps/       step implementations: the real work. May import providers/,
               config/, checks/ and errors.ts, and types from blocks/.
    agent/          run an agent or a plain model call, and take the worktree
                    lock
    ticket/         fetch a ticket snapshot, post and read Linear comments,
                    create and find Linear issues
    pull-request/   branch state, push, open, comment, reply, squash merge
    worktree/       provision, create, clone, tear down, registry, sweep
  service/     the long-running process: app, routes, ingress, schedules,
               readiness, shutdown, the Nitro config and the build.
  cli/         the `jigs` command and its subcommands.
  checks/      the requirement checks, shared by preflight, `jigs doctor` and
               the just-in-time checks a step runs.
  providers/   raw clients with no jigs knowledge: git, GitHub, Linear.
  config/      the factory's config file, root, environment and paths.
  errors.ts
  run-status.ts  which run statuses are terminal; cli/, service/ and steps/
                 all read it.
```

One rule decides where a type goes: a type used by one module stays in that
module, and a type used on both sides of the blocks/steps line lives in
`blocks/`, under the same topic. There is no shared types folder.

Prompts sit beside the code that uses them, as `<name>.prompt.ts`. They are
still exported, so a factory can read one or pass its own instead.

### The two import paths

A factory imports jigs code from two subpaths:

- `@salimhamed/jigs/blocks` is everything a pipeline or a factory's own block
  may call. Nothing behind it touches a node built-in, the environment or the
  network.
- `@salimhamed/jigs/steps` is the implementations a factory wraps in its own
  `"use step"` functions. Every one of them does touch one of those three,
  which is why it is a step. A pipeline never imports this path.

The package root, `@salimhamed/jigs`, carries the handful of types a factory
names in its own code plus `ticketInput`.

The remaining subpaths belong to the service the factory builds:
`@salimhamed/jigs/app`, `/nitro`, `/schedules`, `/build`,
`/plugins/start-world` and `/plugins/start-dashboard`. A factory names
`/nitro` in its `nitro.config.ts`; `jigs build` and the server entry it
generates name the rest.

The package ships compiled, from `dist/`, one entry per export subpath. The
Workflow SDK, its Postgres World, its dashboard and zod are peers the factory
installs itself; the measurements behind that shape are in
[ADR 0017](docs/adr/0017-single-package.md).

## Development

Requires Node 24 or newer and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build (all packages)
pnpm e2e        # jigs init into a temp dir, install from packed tarballs, build twice, diff ids
                # (with WORKFLOW_POSTGRES_URL set: boot the service and stop it too)
```

A merge to `main` with a releasable title opens or updates the release PR;
its merge tags the release and publishes to GitHub Packages. The
[setup runbook](docs/setup.md#part-1--the-machine-once) has the two console
settings that make it work.
