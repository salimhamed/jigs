# Set a factory up

From nothing to a service that answers. The human-facing walkthrough is
`https://salimhamed.github.io/jigs/guide/getting-started`; identity, merge
policy, bindings and webhooks are in
`https://salimhamed.github.io/jigs/guide/configuration`.

Print each command for the human to run, or run it and show them the output.
Nothing below is safe to run silently: every step can fail in a way only a
person can judge.

## What has to be there first

- Node 24 or newer, and pnpm. If node comes from a version manager, the shell
  that runs `jigs up` must have it on `PATH`: the service is spawned with the
  CLI's own node.
- Docker, with the daemon running. Each factory brings up its own Postgres.
- On Linux with systemd, `loginctl enable-linger "$USER"` once, so factory
  services survive the last login session ending.
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

Choose the GitHub identity now; `jigs init --help` lists the flags.
`--github-identity-mode pat` (the default) makes jigs act as the operator, with
a `jigs:approved` label as the merge approval. `--github-identity-mode app`
makes jigs act as a GitHub App and takes the App's id, installations, private
key path and the operator's login; approval is then a GitHub review.
`--linear-identity-mode key|app` does the same for Linear. Both are written to
`jigs.config.ts`, so changing one later is a config edit.

`jigs init` writes `jigs.config.ts`, the generated `jigs.ts`, a `hello`
workflow, the package manifest, Docker Compose, `.env.example` and build
settings. It preserves existing files. Its printed ports come from the factory
path; adjust them in `jigs.config.ts` if they are taken.

## 2. Install and `.env`

```sh
pnpm install
cp .env.example .env
```

`hello` needs no credentials. Leave `WORKFLOW_TARGET_WORLD` and
`WORKFLOW_POSTGRES_URL` as written. Fill in the Linear and GitHub credentials
before adding a workflow that declares those integrations; the configuration
guide's `.env` table lists each variable.

## 3. `jigs up`

```sh
pnpm exec jigs up
```

`jigs up` prints one line per step: `locate`, `env` (fails with
`cp .env.example .env` as its repair when there is no `.env`, and names empty
credential slots), `install`, `compose` (Postgres, its output streamed),
`bootstrap` (migrations), `build`, `service` (start, or restart only when the
built bundle or `jigs.config.ts` changed), `ready` (waits until every binding
is cloned and the World is up) and `doctor`. Doctor checks only what the
workflows require and what `jigs.config.ts` turns on. The closing block names
what runs and the one command that stops it all:

```
my-factory is up

  postgres    localhost:5440  (Docker container my-factory-postgres-1)
  service     http://localhost:8990  (pid 53812)
  dashboard   http://localhost:9090
  logs        ~/.local/share/jigs/services/my-factory-2286ac2a.log

  stop:  pnpm exec jigs down
```

Give the human the dashboard URL and have them open it. `jigs down` stops the
service and Postgres together and keeps the data; `jigs service stop` stops only
the service.

The first failing step prints `FAIL <step>: <why>` with its repair on the next
line, and `up` stops there. Show both lines, follow the repair, then run
`jigs up` again; an unchanged factory installs, migrates and restarts nothing.
A `FAIL ready` names the service log when the service exited during boot; one
after five minutes leaves the process running, so run `jigs service status`
before repairing anything. `jigs doctor` reruns the checks any time the service
is up.

`jigs up` is also the command after every change to the factory's code.
`--restart-service` forces a restart; `--force` skips the question about
in-flight runs.

Then:

```sh
jigs run hello --input message=hello
jigs status
```

## 4. Add a recipe and bind a target repo

```sh
jigs recipe list
jigs recipe add linear-ticket-to-pr
```

`recipe add` copies source without overwriting and registers the workflow under
`workflows` in `jigs.config.ts`. If it cannot edit the config, it names the line
to add by hand. The copied code is the factory's to edit; `blocks/delivery/README.md` explains the linear-ticket-to-pr recipe.

```sh
jigs bind git@github.com:owner/repo.git
jigs bindings
jigs up
```

`jigs bind` adds the binding to `jigs.config.ts` and, with the configured
identity, creates the approval label when approval is a label and the webhook
when GitHub webhooks are on. The service clones each binding when it starts, so the
`jigs up` above is what makes a new binding usable. Worktree provisioning
(`copy`, `postCreate`) is a hand edit described in the configuration guide.

## 5. Webhooks are optional

A parked run wakes without webhooks: the service re-reads each waiting pull
request and ticket every `service.pollIntervalSeconds.github` / `.linear`
seconds (default 300), and `jigs poke <run-id>` wakes one sooner. Webhooks
only make the wake immediate. They need a public tunnel URL, a
`webhooks` block in `jigs.config.ts` and a secret per provider in `.env`; the
configuration guide's webhooks section has the steps.

## Upgrading later

```sh
jigs upgrade
```

It bumps jigs, regenerates `jigs.ts`, runs `jigs up` and typechecks the
factory. Review and commit the regenerated `jigs.ts`.
