# Set a factory up

From nothing to a service that answers. The human-facing walkthrough is
`https://salimhamed.github.io/jigs/guide/getting-started`; merge settings,
bindings and the factory's hub settings are in
`https://salimhamed.github.io/jigs/guide/configuration`. Running a hub, and
creating each provider's app in it, is in
`https://salimhamed.github.io/jigs/guide/hub`.

Print each command for the human to run, or run it and show them the output.
Nothing below is safe to run silently: every step can fail in a way only a
person can judge.

## What has to be there first

- Node 24 or newer, and pnpm. If node comes from a version manager, the shell
  that runs `jigs up` must have it on `PATH`: the service is spawned with the
  CLI's own node.
- Docker, with the daemon running. Each factory brings up its own Postgres.
- Only for the harnesses the factory's workflows use, each logged in to its
  subscription and on the `PATH` of whatever starts the service:
  Claude Code (`claude auth login`), Codex (`codex login`), Pi (`pi`, then
  `/login`). `JIGS_CLAUDE_EXECUTABLE` can point at a `claude` that is not on
  `PATH`. A bare factory needs none of them.
- The AWS CLI, only if a workflow declares `aws: true`.

jigs is on public npm as `@jigs-ai/jigs`, pinned by the factory to a version.
No token is needed to install it, and nothing is installed globally: inside a
factory, `jigs` means `pnpm exec jigs`.

## 1. Scaffold

```sh
mkdir my-factory && cd my-factory && git init
pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init
```

jigs acts on GitHub, Linear, Slack and PagerDuty as the apps the hub assigns
the factory, so there is nothing to choose here. The factory names each
installation it uses by its installation name on the hub, such as
`github-acme`; ask the user for these names when a step below needs one. Add
`linear.operator: "<operator's Linear email>"` to `jigs.config.ts` so ticket
runs' questions and notes mention the operator and the assignee rather than the ticket's
creator.

`jigs init` writes `jigs.config.ts`, a `hello` workflow in
`workflows/hello/hello.ts`, the package manifest, Docker Compose, `.env.example`
and build settings. It preserves existing files. The ports in `.env.example` come
from the factory path; pick others if they are taken.

## 2. Install and the environment

`jigs.config.ts` says what the factory is; the environment says how this copy
runs. jigs reads only the process environment, and the scaffolded
`jigs.config.ts` loads `.env.local`, then `.env`, never replacing a value already
set. `.env` holds values every copy shares (API keys, secrets, channel IDs);
`.env.local` holds this copy's own (ports, `COMPOSE_PROJECT_NAME`,
`WORKFLOW_POSTGRES_URL`, `JIGS_HUB_TOKEN`, `*_ACTIVE` flags). Neither is committed.

```sh
pnpm install
cp .env.example .env
```

Then write `.env.local` from the commented lines at the end of `.env.example`,
uncommented: `COMPOSE_PROJECT_NAME`, the three ports and `WORKFLOW_POSTGRES_URL`.
Never leave an empty `X=` in `.env.local`: it hides the value in `.env`. `hello`
needs nothing else, and no hub.

A factory hears GitHub, Linear, Slack and PagerDuty only through a hub, and needs
one once a workflow, binding or trigger uses one of them. Then ask the user for
the two lines the hub showed when they added the factory (with no hub yet, they
run one first: see the hub guide above): `hub: { url: "<origin>" }` goes in
`jigs.config.ts`, and `JIGS_HUB_TOKEN=<token>` in `.env.local`. GitHub, Linear,
Slack and PagerDuty tokens come from the hub; the configuration guide's
environment tables list every other variable. A copy in a git worktree follows
`https://salimhamed.github.io/jigs/guide/worktrees`.

## 3. `jigs up`

```sh
pnpm exec jigs up
```

`jigs up` prints one line per step: `locate`, `install`, `compose` (Postgres, its output streamed),
`bootstrap` (migrations), `build`, `service` (start, or restart only when the
built bundle or `jigs.config.ts` changed), `ready` (waits until every binding
is cloned and the World is up) and `doctor`. Doctor checks only what the
workflows require and what `jigs.config.ts` turns on. The closing lines name
what runs and the one command that stops it all:

```
my-factory is up
  postgres   localhost:5440 (Docker container my-factory-postgres-1)
  service    http://localhost:8990 (pid 53812)
  dashboard  http://localhost:9090
  logs       ~/.local/share/jigs/services/my-factory-2286ac2a.log
  stop everything:
    pnpm exec jigs down
```

Give the human the dashboard URL and have them open it. `jigs down` stops the
service and Postgres together and keeps the data; `jigs service stop` stops only
the service. Both stop everything the service started, running agents
included. The service runs until it is stopped, the human logs out or the
machine restarts. To start it at login,
`https://salimhamed.github.io/jigs/guide/cli#service-lifetime` has a macOS
LaunchAgent and a Linux systemd user unit that run `jigs up` once. Never set up launchd `KeepAlive` or systemd `Restart=` for the
service itself.

The first failing step prints `FAIL <step>: <why>` with its repair indented on
the lines below, each command on a line of its own, and `up` stops there. Show
the whole block, follow the repair, then run `jigs up` again; an unchanged
factory installs, migrates and restarts nothing. A `FAIL ready` after the
service exited during boot prints the end of its log and points at
`jigs service logs` and the log file; one after five minutes leaves the process
running, so run `jigs service status` before repairing anything. `jigs doctor` reruns the checks any time the service
is up.

`jigs up` is also the command after every change to the factory's code.
`--restart-service` forces a restart, which a change to the environment
(`.env`, `.env.local`) needs; `--force` skips the question about
runs with a step executing.

Then:

```sh
jigs run hello
jigs status
```

## 4. Add a recipe and bind a target repo

```sh
jigs recipe list
jigs recipe add linear-ticket-to-pr
```

`recipe add` copies source without overwriting and registers the workflow under
`workflows` in `jigs.config.ts`. If it cannot edit the config, it names the line
to add by hand. The copied code is the factory's to edit; `workflows/linear-ticket-to-pr/README.md` explains the linear-ticket-to-pr recipe.

```sh
jigs bind git@github.com:owner/repo.git --installation <github-installation>
jigs bindings
jigs up
```

`jigs bind` adds the binding, with the GitHub installation that reaches the
repository as its `installationName`, to `jigs.config.ts`, creates the factory's
`bindings/<name>/` folder with a README when it is missing, and, with the
factory's GitHub App, creates the `jigs:approved` label. The service clones each binding into
`~/.local/share/jigs/clones/<factory>/<name>/` when it starts, so the `jigs up`
above is what makes a new binding usable. That data folder is jigs's own and is
separate from the factory's `bindings/<name>/`, whose files `copy` lists for
each new worktree. Worktree provisioning (`copy`, `postCreate`) is a hand edit
described in the configuration guide.

## 5. Events come through the hub

GitHub, Linear, Slack and PagerDuty events all come through the hub, and wake
a parked run at once. `jigs poke <run-id>` wakes one whose event was missed.
Each running copy needs its own factory on the hub: two copies with one token
split its events. Triggers and schedules run only in a copy whose environment
turns them on (`active`, usually `<NAME>_ACTIVE=true` in `.env.local`), and the
service refuses to start when an active one needs a provider and the copy has
no hub connection.

## Upgrading later

Set the new `@jigs-ai/jigs` version in `package.json`, then:

```sh
pnpm install
pnpm exec jigs up
pnpm typecheck
```

`jigs up` stops if a waiting run needs a step the new build lacks; go back to
the previous version, let it finish or cancel it, then upgrade again. Library imports come from the root `@jigs-ai/jigs`;
routines such as `acquireTicket` or `agentSession` come from `#jigs/routines`.
