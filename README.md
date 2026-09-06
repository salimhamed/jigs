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

`jigs init` writes the infrastructure — `jigs.yml`, `package.json`,
`nitro.config.ts`, `docker-compose.yml`, `.env.example` and the rest of the
build config — and the code the factory starts from, then prints the remaining
steps with **your** ports filled in. Use its numbers, not the ones below.

### 3. Read the factory's own code

Everything `jigs init` wrote is yours now: it never rewrites a file that
exists. Three of them are the code `jigs build` compiles:

- `jigs.config.ts` — this factory's pipelines, keyed by the name `jigs run` takes.
- `pipelines/ship.ts` — a ticket to a merged pull request, the starter pipeline.
- `steps/jigs.ts` — this factory's `"use step"` wrappers around the steps jigs
  ships, and the jigs wired on top of them. `steps/describe-pr.ts` beside it
  is the one review-loop dep jigs has no default for.

Never rename `steps/jigs.ts` or its exported functions — the runtime memoizes
parked runs against those names. `jigs.config.test.ts` pins the ids the last
build emitted, so `pnpm test` in the factory catches a rename.

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
jigs bind git@github.com:owner/repo.git
jigs bindings
```

A **binding** maps a name to a target repo's remote URL plus how its worktrees
are provisioned; jigs keeps its own clone per binding and cuts agent worktrees
from it.

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

`jigs service start` returns once the service is fully up, so both work
straight away. Then:

```sh
jigs run <pipeline> --input ticket=AGE-123
jigs ps
jigs logs <run>
```

`<run>` is a run id, a unique prefix of one, or the ticket the run claimed.

### Upgrading later

A factory pins both packages to one published version, so an upgrade moves
both pins together and runs `jigs up`. The **Upgrading** notes in
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
- `packages/service` — `@salimhamed/jigs-service`, the library a factory
  installs: the app and its routes, and the primitives pipelines are written
  against. It ships compiled, from `dist/`, like the CLI.
- `packages/jigs/templates` — what `jigs init` writes: the factory's
  infrastructure and the code it starts from, one `.tmpl` per file.

## Development

Requires Node 24 or newer and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build (all packages)
pnpm e2e        # jigs init into a temp dir, build it twice, diff its step ids
                # (with WORKFLOW_POSTGRES_URL set: boot the service and stop it too)
```
