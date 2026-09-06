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
exists. Three of them are the code `jigs build` compiles:

- `jigs.config.ts` — this factory's pipelines, keyed by the name `jigs run` takes.
- `pipelines/ship.ts` — a ticket to a merged pull request, the starter pipeline.
- `pipelines/review-loop.ts` — the review loop, composed from the blocks jigs
  ships: implement ⇄ review, push, describe, open, gate, answer, fix, merge.
  The order, the CI bound, the merge policy and the escalation prose are the
  factory's, and this file is where they are read and changed.
- `steps/jigs.ts` — this factory's `"use step"` wrappers around the steps jigs
  ships, and the blocks wired on top of them. `steps/describe-pr.ts` beside it
  holds the words a pull request introduces itself with.

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
pnpm exec jigs service restart
```

A **binding** maps a name to a target repo's remote URL plus how its worktrees
are provisioned; jigs keeps its own clone per binding and cuts agent worktrees
from it. The service makes the clones when it starts, hence the restart.

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

pnpm workspace, one published package:

- `packages/jigs` — `@salimhamed/jigs`: the `jigs` CLI; the library-first core
  behind it (harnesses, checks, prompts, step implementations); the service a
  factory builds and runs (the app and its routes, the Nitro config, the
  suspension, ticket, review-loop and worktree building blocks pipelines are
  composed from); and under `templates/` everything `jigs init` writes —
  the factory's infrastructure and the code it starts from, one `.tmpl` per
  file.

It ships compiled, from `dist/`, one entry per export subpath. The Workflow
SDK, its Postgres World, its dashboard and zod are peers the factory installs
itself; the measurements behind that shape are recorded in
[`docs/adr/`](docs/adr/).

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
