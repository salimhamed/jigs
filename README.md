# jigs

> In manufacturing, a jig guides tools through repeatable operations.
> In software, jigs guides coding agents through repeatable workflows.

jigs turns a repeatable piece of development work — take this ticket, implement
it, review it, open the pull request, merge it — into a **pipeline** you write
once and run whenever you want. A pipeline is plain TypeScript: coding agents do
the work, and the runtime records every step so a run can idle for days waiting
on a human and pick up exactly where it left off. It is a library and a CLI, not
an application: you run it on your own machine, against your own repos.

## How it fits together

Your pipelines live in a **factory repo** — one per person, scaffolded by
`jigs init`. `jigs build` compiles that factory's pipelines into a **service**
of its own, backed by its own Postgres **World** on its own port, and
`jigs service start` supervises it. From then on everything is a client of that
service: `jigs run` creates a run, the service executes it with coding agents in
git worktrees, `jigs ps` and `jigs logs` say what is happening, the **dashboard**
the service hosts shows the full step history, and **schedules** declared in the
factory fire pipelines on a cron tick. Two factories on one machine share
nothing — not a port, not a container, not a run.

## Quick start

Nothing is published to npm yet, so a factory links a local checkout of this
repo and `jigs init` runs from that checkout's build. Expect around fifteen
minutes.

**Prerequisites.** Node 24 or newer, pnpm, Docker with the daemon running, and
the coding-agent CLIs your pipelines will drive — `claude` and `codex` — each
logged in to its subscription. If node comes from a version manager, make sure
the shell you start the service from has it on `PATH`.

### 1. Clone jigs and build the CLI

```sh
git clone https://github.com/salimhamed/jigs.git
cd jigs
pnpm install
pnpm build
```

Then put `packages/jigs/dist/cli.js` on your `PATH` as `jigs`, however you
prefer — a symlink is fine. Inside a factory repo, `pnpm exec jigs` also works
without this.

### 2. Scaffold a factory

```sh
mkdir my-factory && cd my-factory && git init
jigs init
```

`jigs init` writes infrastructure only — `jigs.yml`, `package.json`,
`nitro.config.ts`, `docker-compose.yml`, `.env.example`, `tsconfig.json`,
`pnpm-workspace.yaml`, `.gitignore` — and prints the rest of this quick start
with **your** ports filled in. Its ports are derived from the factory's path, so
two factories never collide; use the numbers it gives you rather than the ones
below.

```
my-factory listens on :9010, its dashboard on :9110, its World on :5460
```

### 3. Write the factory's own code

`jigs init` scaffolds no pipeline code on purpose, and `jigs build` has nothing
to compile without it. Three things are yours to write:

- `jigs.config.ts` — this factory's pipelines, keyed by the name `jigs run` takes.
- `pipelines/` — one file per pipeline.
- `steps/jigs.ts` — this factory's `"use step"` wrappers around the steps jigs
  ships, and the jigs wired on top of them.

`e2e/fixture-factory/` in this repo is the smallest complete factory; copy its
shape. Do not rename that file or its exported functions later — those names are
what the runtime memoizes parked runs against.

### 4. Environment and World

```sh
cp .env.example .env      # then fill in LINEAR_API_KEY and GITHUB_TOKEN
pnpm install
docker compose up -d --wait
pnpm exec bootstrap
```

`bootstrap` applies the database migrations and the queue schema; it reads the
factory's `.env` and is safe to re-run. Both tokens are checked on every trigger,
so a run cannot be created without them.

### 5. Bind a target repo

```sh
jigs bind ../some-target-repo
jigs bindings
```

A **binding** is a name mapped to an existing checkout and pinned to its remote.
Pipelines name bindings; the runtime makes worktrees from them.

### 6. Build and start the service

```sh
jigs build
jigs service start
```

```
started my-factory: pid 3343834 at http://localhost:9010
dashboard: http://localhost:9110
logs: ~/.local/share/jigs/services/my-factory.log
```

Open the dashboard URL it prints. `jigs service status` prints both URLs again
whenever you need them.

### 7. Check, then run

```sh
jigs doctor    # the check catalog, run inside the service's own environment
jigs ps        # "no runs" is the right answer here
```

`jigs doctor` asks the running service, so the service has to be up — and
`jigs service start` returns as soon as it has spawned the process, so a verb
run immediately after can still report that nothing is listening. Give it a
second and try again. Every failing check comes with the command that repairs
it. Then:

```sh
jigs run <pipeline> --input ticket=AGE-123
jigs ps
jigs logs <run>
```

`<run>` is a run id, a unique prefix of one, or the ticket the run claimed.
`jigs logs` prints the run's state, its step timeline, and a link to its page on
the dashboard.

### Upgrading later

The `jigs` command runs from `packages/jigs/dist/`, which is gitignored and
refreshed only by `pnpm build`. The service half ships as source and is live the
moment you pull, so a pull without a rebuild leaves an old CLI talking to a new
service. Upgrade in this order:

```sh
cd <jigs checkout> && git pull && pnpm build
cd <factory> && git pull && pnpm install
pnpm exec jigs build && pnpm exec jigs service restart
pnpm exec jigs service status
```

## The `/jigs` skill

```sh
npx skills add salimhamed/jigs
```

installs a skill your coding agent can run as `/jigs`. It is invoked by you, not
chosen by the model, and it takes a plain-language argument that it routes to one
of four files:

- **operate** — run, watch, diagnose, cancel or sweep; answer a halt that is
  waiting on a human.
- **author** — write a pipeline, a step, a prompt, a schedule, or a `requires`
  manifest.
- **setup** — from nothing to a first run.
- **ask** — answer a question about jigs from its own sources, and change nothing.

The skill's sources live in `skills/jigs/`.

## Where to read next

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. Every term above is defined there.
- [`docs/setup.md`](docs/setup.md) — the full runbook: the machine once, then a
  factory at a time, including webhook ingress and step timeouts.
- [`docs/adr/`](docs/adr/) — one file per decision, and why the alternatives
  were rejected.

## Layout

pnpm workspace:

- `packages/jigs` — the library-first package and the `jigs` CLI.
- `packages/service` — `@jigs/service`, the library a factory repo installs: the
  app and its health, trigger, resume and run routes, the step, suspension and
  worktree primitives pipelines are written against, the Nitro build config, and
  the infrastructure templates `jigs init` scaffolds from. It ships as raw
  TypeScript with no build step; the factory's own build compiles it.
- `e2e/fixture-factory` — a one-pipeline factory repo with its own `steps/jigs.ts`,
  `jigs.config.ts` and pipeline. CI builds it twice, once with `@jigs/service` on
  a fake version, and diffs the emitted step ids against a checked-in list both
  times. It is also the worked example a new factory copies from.

Both packages carry ordinary semver. Every `"use step"` wrapper lives in the
factory that runs it, so no step id carries a jigs version and a release never
renames a memoization key.

## Development

Requires Node 24 or newer and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build (all packages)
pnpm e2e        # build e2e/fixture-factory twice and diff its step ids
```

No pipeline lives in this repo, so `pnpm build` compiles no workflow directive —
`pnpm e2e` is what proves that half still works.
