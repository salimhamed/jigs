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
  worktrees.
- The **dashboard** the service hosts shows every run's full step history.
- **Schedules** declared in the factory fire pipelines on a cron tick.

## Quick start

> [!NOTE]
> Nothing is published to npm yet, so a factory links a local checkout of this
> repo and `jigs init` runs from that checkout's build. Expect around fifteen
> minutes.

**Prerequisites.**

- Node 24 or newer.
- pnpm.
- Docker, with the daemon running.
- The coding-agent CLIs your pipelines will drive — `claude` and `codex` — each
  logged in to its subscription.
- If node comes from a version manager, the shell you start the service from
  needs it on `PATH`.

### 1. Clone jigs and build the CLI

```sh
git clone https://github.com/salimhamed/jigs.git
cd jigs
pnpm install
pnpm build
```

Then put the built CLI on your `PATH` as `jigs`:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/packages/jigs/dist/cli.js" ~/.local/bin/jigs
```

### 2. Scaffold a factory

```sh
mkdir my-factory && cd my-factory && git init
jigs init
```

`jigs init` writes infrastructure only — `jigs.yml`, `package.json`,
`nitro.config.ts`, `docker-compose.yml`, `.env.example` and the rest of the
build config — then prints the remaining steps with **your** ports filled in.
Use its numbers, not the ones below.

### 3. Write the factory's own code

`jigs init` scaffolds no pipeline code, and `jigs build` has nothing to compile
without it. Three things are yours to write:

- `jigs.config.ts` — this factory's pipelines, keyed by the name `jigs run` takes.
- `pipelines/` — one file per pipeline.
- `steps/jigs.ts` — this factory's `"use step"` wrappers around the steps jigs
  ships, and the jigs wired on top of them.

Copy the shape from `e2e/fixture-factory/` in this repo. Never rename
`steps/jigs.ts` or its exported functions — the runtime memoizes parked runs
against those names.

### 4. Environment and World

```sh
cp .env.example .env      # then fill in LINEAR_API_KEY and GITHUB_TOKEN
pnpm install
docker compose up -d --wait
pnpm exec bootstrap
```

`bootstrap` applies the database migrations and the queue schema, and is safe to
re-run.

### 5. Bind a target repo

```sh
jigs bind ../some-target-repo
jigs bindings
```

A **binding** maps a name to an existing checkout; pipelines name bindings, and
the runtime makes worktrees from them.

### 6. Build and start the service

```sh
jigs build
jigs service start
```

Open the dashboard URL it prints. `jigs service status` prints it again whenever
you need it.

### 7. Check, then run

```sh
jigs doctor    # the check catalog, run inside the service's own environment
jigs ps        # "no runs" is the right answer here
```

`jigs service start` returns before the port is listening, so give it a second
before deciding a check failed. Then:

```sh
jigs run <pipeline> --input ticket=AGE-123
jigs ps
jigs logs <run>
```

`<run>` is a run id, a unique prefix of one, or the ticket the run claimed.

### Upgrading later

Rebuild this checkout before the factory: the CLI runs from a build only
`pnpm build` refreshes, while the service half ships as source and is live the
moment you pull. The **Upgrading** notes in
[the setup runbook](docs/setup.md#part-1--the-machine-once) carry the commands
in order.

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

pnpm workspace:

- `packages/jigs` — the library-first package and the `jigs` CLI.
- `packages/service` — `@jigs/service`, the library a factory installs: the app
  and its routes, and the primitives pipelines are written against. It ships as
  raw TypeScript; the factory's own build compiles it.
- `e2e/fixture-factory` — a one-pipeline factory, and the worked example a new
  factory copies from.

## Development

Requires Node 24 or newer and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build (all packages)
pnpm e2e        # build e2e/fixture-factory twice and diff its step ids
```
