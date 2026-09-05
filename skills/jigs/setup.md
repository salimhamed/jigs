# Set a factory up

From nothing to a service that answers. `docs/setup.md` in the jigs checkout is
the full runbook and the source of truth; this file is the order of operations
and the places people get stuck.

Print each command for the human to run, or run it and show them the output.
Nothing below is safe to run silently: every step can fail in a way only a
person can judge.

## What has to be there first

- Node 24 or newer, and pnpm. If node comes from a version manager, the shell
  that runs `jigs service start` must have it on `PATH` — the service is spawned
  with the CLI's own node.
- Docker, with the daemon running. Each factory brings up its own Postgres; none
  of it is shared.
- The agent harness CLIs the factory's pipelines will drive — `claude` and
  `codex` — each logged in to its subscription.
- The AWS CLI, only if a pipeline will declare `aws: true`.
- A tunnel tool (`tailscale` or `cloudflared`), only if the factory will receive
  provider webhooks.

Nothing is published to npm yet. A factory links a local checkout of the jigs
repo, and `jigs init` runs from that checkout's build.

## 1. The jigs checkout, once per machine

```sh
git clone https://github.com/salimhamed/jigs.git
cd jigs
pnpm install
pnpm build
```

Then put `packages/jigs/dist/cli.js` on `PATH` as `jigs`. That built file is
what `jigs` runs — see the upgrade note at the bottom.

## 2. Scaffold the factory

```sh
mkdir my-factory && cd my-factory && git init
jigs init
```

`jigs init` writes infrastructure only — `jigs.yml` (the service and dashboard
ports, derived from this factory's path so two factories never collide),
`package.json`, `nitro.config.ts`, `docker-compose.yml`, `.env.example`,
`tsconfig.json`, `pnpm-workspace.yaml`, `.gitignore` — then prints the remaining
commands with this factory's own ports filled in. Use the numbers it prints, not
any numbers you have seen elsewhere.

**It scaffolds no code.** `jigs.config.ts`, `pipelines/` and `steps/jigs.ts` are
the factory's to write, and `jigs build` fails without them. Copy the shape from
`e2e/fixture-factory/` in the jigs checkout, then follow `author.md`.

## 3. Install, World, bootstrap

```sh
cp .env.example .env
pnpm install
docker compose up -d --wait
pnpm exec bootstrap
```

`bootstrap` applies the SDK's migrations and the graphile-worker schema, reads
the factory's `.env` for the World URL, and is idempotent.

Fill in `.env` before the first run: `LINEAR_API_KEY` and `GITHUB_TOKEN` are
validated on **every** trigger, so a run cannot be created without both, even
for a pipeline that touches neither. `WORKFLOW_TARGET_WORLD` and
`WORKFLOW_POSTGRES_URL` come filled in and should be left alone.

## 4. Bind the target repos

```sh
jigs bind git@github.com:owner/repo.git
jigs bindings
```

A binding is a name in `jigs.yml` mapped to a target repo's remote URL. jigs
keeps its own bare clone per binding under
`~/.local/share/jigs/bindings/<factory>/<binding>/repo.git`, cloned on the first
worktree request, and cuts every worktree from it — the operator's own checkout
is not involved. Anything a worktree needs that git does not carry (an `.env`,
an untracked `.jigs.yml`) goes in that binding's `seed/` directory, where a
`.jigs.yml` wins over the repo's own. `jigs bind` also creates the repo's GitHub
webhook, but only when the factory has an `ingress_url` in `jigs.yml` and
`GITHUB_TOKEN` is set in the environment — it says which one it skipped and why.
`jigs unbind` edits the config only; the clone stays on disk.

## 5. Build and start

```sh
jigs build
jigs service start
jigs service status
```

`jigs service start` prints the service URL and the dashboard URL. Both come
from `jigs.yml`; do not guess either.

```
started my-factory-2286ac2a: pid 3343834 at http://localhost:9010
dashboard: http://localhost:9110
logs: ~/.local/share/jigs/services/my-factory-2286ac2a.log
```

Open the dashboard URL to confirm it answers, then:

```sh
jigs doctor   # the check catalog, in the service's own environment
jigs ps       # "no runs" is the right answer here
```

`jigs doctor` is an HTTP call into the service, so the service has to be up for
it to say anything at all — and `jigs service start` returns before the port is
listening, so give it a second before deciding a start failed.

## 6. Webhook ingress, only if the factory needs it

The service's `/ingress/github` and `/ingress/linear` routes must be reachable
from the public internet on this factory's service port for a suspended run to
wake on its own. Run a tunnel, put the URL in `jigs.yml` as `ingress_url`,
re-bind each target repo with `GITHUB_TOKEN` set, and create a Linear webhook
for `Comment` resources. `docs/setup.md` has the exact commands and the
org-level alternative. Without ingress everything still works; a suspended run
just needs `jigs poke <run>` to notice its answer.

## Upgrading a factory later

The CLI runs from `packages/jigs/dist/`, which is gitignored and refreshed only
by `pnpm build`. `@jigs/service` ships source, so the service side of a change
is live the moment you pull, while the CLI keeps running the old build until you
rebuild it — which shows up as the CLI rejecting a `jigs.yml` field it has not
learned about yet. So, in this order:

```sh
cd <jigs checkout> && git pull && pnpm build
cd <factory> && git pull && pnpm install
pnpm exec jigs build && pnpm exec jigs service restart
pnpm exec jigs service status
```

Two things a pull does not do on its own: install a new runtime dependency the
release added (compare against `jigs init`'s `package.json` template), and
extend this factory's `steps/jigs.ts` with a wrapper for a step jigs has grown.
The factory's own typecheck is what reports the second.
