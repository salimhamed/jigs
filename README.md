# jigs

> In manufacturing, a jig guides tools through repeatable operations.

jigs runs durable TypeScript workflows that combine agents, model calls, and
external operations. Use it to deliver software, investigate infrastructure,
or automate another repeatable process. Factories own the process and policy.

## How it fits together

- Your workflows live in a **factory repo**, one per person, scaffolded by `jigs init`.
- `jigs build` compiles that factory's workflows into a **service** of its own,
  backed by its own Postgres **World** on its own port.
- `jigs run` creates a run, and the service executes it with coding agents in git
  worktrees **cut from jigs' own clone of the target repo**.
- The **dashboard** the service hosts shows every run's full step history.
- **Schedules** declared in the factory fire workflows on a cron tick.

## Quick start

jigs ships as one package on GitHub Packages, `@salimhamed/jigs`: the CLI, and
the library a factory is written against. A factory pins it to a version and
runs its own copy of the CLI; nothing is installed globally and nothing is
cloned. Expect around ten minutes.

**Prerequisites.**

- Node 24 or newer, and pnpm.
- Docker, with the daemon running.
- The coding-agent CLIs your workflows will drive — `claude` and `codex` — each
  logged in to its subscription. Install both yourself and keep them on the
  `PATH` of whatever starts the service; it will not start without them.
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

`jigs init` writes files and runs nothing: `jigs.config.ts`, `package.json` pinned to
the version that scaffolded it, `nitro.config.ts`, `docker-compose.yml`,
`.env.example`, the build config — and the code the factory starts from. Then
it prints the remaining steps with **your** ports filled in. Use its numbers,
not the ones below.

### 3. Read the factory's own code

The factory separates its configuration, generated integration, and custom code:

- `jigs.config.ts` declares service ports, bindings, deferred workflow imports,
  schedules, the GitHub identity jigs runs as, and this factory's merge policy.
  Workflow modules export their function, inputs and requirements together.
- `jigs.ts` is generated, committed integration code: named durable step wrappers
  and ready-to-call jigs blocks. Never put custom code here. `jigs generate`
  refreshes it from the installed library; `jigs build` reports stale code.
- `workflows/ship.ts` is the starter workflow: a ticket to a merged pull request.
- `blocks/` holds factory-specific prompts, ticket acquisition, and domain decisions.
- The optional delivery module supplies `deliverChange` and its independently usable phases.
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
Wrappers pass run metadata to jigs, which handles run-specific details such as
dashboard links. Call `removeMergedRunWorktrees` only after a successful merge.

Both workflow and step function paths and names contribute to durable IDs.
Renames are supported breaking changes: finish or cancel affected active runs
before deploying them. Ordinary library version bumps do not change these IDs.

### 4. Tokens, then up

```sh
cp .env.example .env      # fill in LINEAR_API_KEY and GITHUB_TOKEN
pnpm install              # puts the factory's own jigs in node_modules/.bin
pnpm exec jigs up
```

`GITHUB_TOKEN` is the credential of the default `pat` identity, where jigs acts
as you. `jigs init --identity app` scaffolds the other one, where jigs acts as
a GitHub App and you can approve the pull requests it opens; it needs an App
registration and its private key instead, and no `GITHUB_TOKEN`. Both, and the
merge policy beside them, are in [setup](docs/setup.md).

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
pnpm exec jigs doctor # reports repository settings that need attention
pnpm exec jigs up --restart
```

A **binding** maps a name to a target repo's remote URL and worktree provisioning
settings. jigs keeps a clone per binding and creates agent worktrees from it.
The service prepares those clones when it starts. Run `jigs up` after editing
configuration; it rebuilds and restarts when the configuration changes.
`--restart` can explicitly request a restart.

`jigs bind` edits a literal `bindings` object in `jigs.config.ts` using the
TypeScript syntax tree. Without `--name`, an existing binding with the exact
remote URL is reused; otherwise its name comes from the repo name. An explicit
`--name` bypasses that match and can create another binding for the same remote.
Unsupported expressions produce a clear error before any file or webhook
changes; those configurations can be edited manually.

### 6. Run

```sh
pnpm exec jigs run <workflow> --input ticket=AGE-123
pnpm exec jigs ps
pnpm exec jigs logs <run>
pnpm exec jigs watch
```

`<run>` is a run id, a unique prefix of one, or the ticket the run claimed.
`jigs logs` prints the run's page on the dashboard `jigs up` named.

`jigs ps` names each run's ticket, its pull request, how long since it last
moved, the result it ended with — `merged` and `limit-reached` are both
`completed` to the runtime — and, for a parked run, what it is waiting for and
the link to act on. `jigs logs` says the same for one run and adds the question
a halt asked. `jigs watch` is one long-lived process that follows every run in
the factory, a line per step, suspension, resume, terminal state and new run.
All three take `--json`.

### Upgrading later

```sh
pnpm exec jigs upgrade
```

normalizes jigs' release-age exclusion, then bumps jigs to the latest release
(`--to <version>` pins it) and runs `jigs up`. During that `up`, it installs
the release, regenerates `jigs.ts` through the installed CLI, then builds and
starts the factory. Finally it typechecks the factory. Review and commit the
regenerated `jigs.ts` and any `pnpm-workspace.yaml` normalization. Custom code
is never generated.

## Factory control

See [the delivery guide](docs/delivery.md) for role/model selection, budgets,
prompt overrides, custom ticket sources, and composing individual phases. Generic
agent workflows use the same core without adopting any delivery concepts.

## The `/jigs` skill

```sh
npx skills add salimhamed/jigs
```

installs a skill your coding agent can run as `/jigs`. It takes a plain-language
argument and routes it to one of four guides:

- **operate** — run, watch, diagnose, cancel or sweep; answer a halt waiting on a
  human.
- **author** — write a workflow, a step, a prompt, a schedule, or a `requires`
  manifest.
- **setup** — from nothing to a first run.
- **ask** — answer a question about jigs, and change nothing.

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. Every term above is defined there.
- [`docs/setup.md`](docs/setup.md) — the full runbook.
- [`docs/adr/`](docs/adr/) — one file per decision.

## Layout

jigs is one root package, published as `@salimhamed/jigs`. `src/` contains
its implementation and `templates/` contains the factory scaffold.
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
process a factory builds and starts: the webhook routes, the scheduler, the
run endpoints and the dashboard. It never runs inside a workflow at all.

What goes into that sandboxed bundle is decided by the two Workflow SDK
markers, and both live only in the factory: `"use workflow"` on each workflow,
`"use step"` on each wrapper. No file in this repo carries either: a directive
here would put this package's version inside every durable step id, and bumping
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
  blocks/      workflow-side code: the blocks a workflow calls.
               May import other blocks, zod, the workflow SDK, and `import
               type` from anywhere. May not import a value from a node
               built-in, the environment, the network, or steps/, service/,
               cli/, checks/, config/ or providers/.
    agent/          how a workflow calls an agent
    delivery/       configurable delivery phases and role/session tracking
    builder-agent/  the moves the builder agent makes: implement, answer a
                    review, fix CI, describe a PR
    ticket/         claim a ticket, review it, shape its snapshot, and halt
                    the run for a human
    pull-request/   the pull request gate, waiting on it, the answers posted
                    back to it, and the hidden markers those answers carry
    factory.ts      the types a factory declares its workflows with
    worktree.ts     the WorktreeFacts type a workflow passes around
  steps/       step implementations: the real work. May import providers/,
               config/, checks/, errors.ts and blocks/.
    run-directory/  scratch directories owned by a run
    agent/          run an agent or a plain model call, and take the worktree
                    lock
    ticket/         fetch a ticket snapshot, post and read Linear comments,
                    create and find Linear issues
    pull-request/   branch state, push, open, comment, reply, merge
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

### Import paths

Workflow-side modules are available independently:

- `/agents`: agent and model calls, harness configuration, and sessions.
- `/linear`: ticket acquisition, clarification, and human replies.
- `/pull-requests`: watching GitHub review and CI state.
- `/delivery`: `deliverChange` and its individual phases.

The broader paths remain available:

- `@salimhamed/jigs/blocks` is everything a workflow or a factory's own block
  may call. Nothing behind it touches a node built-in, the environment or the
  network.
- `@salimhamed/jigs/steps` is the implementations a factory wraps in its own
  `"use step"` functions. Every one of them does touch one of those three,
  which is why it is a step. A workflow never imports this path.

The package root, `@salimhamed/jigs`, carries the handful of types a factory
names in its own code plus `ticketInput` and `defineFactory`.

The remaining subpaths belong to the service the factory builds:
`@salimhamed/jigs/app`, `/nitro`, `/schedules`, `/build`,
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
pnpm e2e        # jigs init into a temp dir, install from packed tarballs, build twice, diff ids
                # (with WORKFLOW_POSTGRES_URL set: boot the service and stop it too)
```

Biome formats code with a line width of 100 characters. Keep the generated
`jigs.ts` template formatted the same way so formatting a factory does not make
its integration appear stale.

A merge to `main` with a releasable title opens or updates the release PR;
its merge tags the release and publishes to GitHub Packages. The
[setup runbook](docs/setup.md#part-1--the-machine-once) has the two console
settings that make it work.
