# Set a factory up

From nothing to a service that answers. `docs/setup.md` in the jigs repo is the
full runbook and the source of truth; this file is the order of operations and
the places people get stuck.

Print each command for the human to run, or run it and show them the output.
Nothing below is safe to run silently: every step can fail in a way only a
person can judge.

## What has to be there first

- Node 24 or newer, and pnpm. If node comes from a version manager, the shell
  that runs `jigs up` must have it on `PATH` — the service is spawned with the
  CLI's own node.
- Docker, with the daemon running. Each factory brings up its own Postgres; none
  of it is shared.
- A GitHub **classic** personal access token with `read:packages` (and `repo`
  while the jigs repo is private), in `~/.npmrc`:

  ```
  @salimhamed:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=<token>
  ```

  Fine-grained tokens cannot read GitHub Packages. A 404 from
  `npm.pkg.github.com` during an install is this token missing or wrong, not a
  missing package.
- The agent harness CLIs the factory's pipelines will drive — `claude` and
  `codex` — each logged in to its subscription.
- The AWS CLI, only if a pipeline will declare `aws: true`.
- A tunnel tool (`tailscale` or `cloudflared`), only if the factory will receive
  provider webhooks.

jigs is one package on GitHub Packages, `@salimhamed/jigs`, pinned by the
factory to a version. Nothing is cloned and nothing is installed globally:
inside a factory, `jigs` means `pnpm exec jigs`.

## 1. Scaffold the factory

```sh
mkdir my-factory && cd my-factory && git init
pnpm dlx @salimhamed/jigs init
```

`jigs init` writes files and runs nothing: `jigs.yml` (the service and
dashboard ports, derived from this factory's path so two factories never
collide), `package.json` pinned to the CLI's own version, `.npmrc` (the scope
line only, never the token), `nitro.config.ts`, `docker-compose.yml`,
`.env.example`, `tsconfig.json`, `pnpm-workspace.yaml`, `.gitignore` — and the
code the factory starts from: `jigs.config.ts`, `pipelines/ship.ts`,
`pipelines/review-loop.ts`, `steps/jigs.ts`, `steps/describe-pr.ts`,
`jigs.config.test.ts`, `README.md`.
Then it prints the remaining commands with this factory's own ports filled in.
Use the numbers it prints, not any numbers you have seen elsewhere.

**It writes every file once.** A file that exists is kept, never rewritten, so
the scaffolded code is the factory's own from the first commit; `author.md`
covers extending it. Edit any of it — but renaming or moving `steps/jigs.ts`
or one of its exported wrappers changes a durable step id, so do that only
when `jigs ps` shows no parked runs.

## 2. Tokens

```sh
cp .env.example .env
```

Fill in `LINEAR_API_KEY` and `GITHUB_TOKEN` before the first run: both are
validated on **every** trigger, so a run cannot be created without them, even
for a pipeline that touches neither. `WORKFLOW_TARGET_WORLD` and
`WORKFLOW_POSTGRES_URL` come filled in and should be left alone.

## 3. Up

```sh
pnpm install          # once, so the factory's own jigs exists
pnpm exec jigs up
```

`jigs up` runs, in order, each on its own line: env (copies `.env.example` if
there is no `.env`, reports empty credential slots), install, compose (the
World), bootstrap (migrations), build, service (start, or restart only if the
bundle changed), ready (waits until the service reports itself ready — every
binding cloned, World up — printing each boot phase), doctor. The last line
names the service and dashboard URLs:

```
ok   locate (3ms) — /home/you/my-factory
ok   env (1ms)
ok   install (4.7s)
ok   compose (2.1s)
ok   bootstrap (1.3s)
ok   build (1.9s)
ok   service (12ms)
ok   ready (1.8s)
ok   doctor (0.4s)
my-factory-2286ac2a is up at http://localhost:9010 — dashboard http://localhost:9110
```

The first failing step prints `FAIL <step>: <why>` and its repair on the next
line, and `up` exits 1 there. Show the human both lines and follow the repair;
then run `jigs up` again — an unchanged factory installs, migrates and
restarts nothing. `jigs up` is also the command after every change to the
factory's code. `--restart` forces a restart, `--force` skips the question
about in-flight runs, `--no-doctor` skips the last step. A `FAIL ready` names
the log when the service exited during boot (a binding it could not clone, a
World it could not open); one after five minutes leaves the process running,
so `jigs service status` before repairing anything.

Confirm the dashboard URL answers, then:

```sh
jigs ps       # "no runs" is the right answer here
```

## 4. Bind the target repos

```sh
jigs bind git@github.com:owner/repo.git
jigs bindings
jigs service restart     # or jigs up --restart
```

A binding is a name in `jigs.yml` mapped to a target repo's remote URL. jigs
keeps its own bare clone per binding under
`~/.local/share/jigs/bindings/<factory>/<binding>/repo.git` and cuts every
worktree from it — the operator's own checkout is not involved. The service
makes those clones when it starts, so the restart above is what makes a new
binding usable (seconds, up to a minute for a large repo); `jigs doctor`
reports a binding with no clone yet.

The binding also carries how its worktrees are provisioned — `jigs bind` writes
`remote:` only, the rest is hand-edited and optional:

```yaml
bindings:
  forge:
    remote: git@github.com:owner/Forge.git
    copy: [.env]
    post_create: [npm ci]
    hook_timeout_minutes: 20
```

A `copy:` entry is a path relative to the binding's own `bindings/<name>/`
directory in the factory repo and lands at that same relative path in the
worktree — `bindings/forge/.env` above arrives as `.env` at the worktree root.
An entry that matches nothing, or that reaches outside that directory, fails
the worktree request by name. `.env`-class files therefore belong in the
factory repo under `bindings/<name>/`, gitignored as `bindings/*/.env`, never
in the target repo. `jigs bind` also creates the repo's GitHub webhook, but
only when the factory has an `ingress_url` in `jigs.yml` and `GITHUB_TOKEN` is
set in the environment — it says which one it skipped and why. `jigs unbind`
edits the config only; the clone stays on disk.

## 5. Webhook ingress, only if the factory needs it

The service's `/ingress/github` and `/ingress/linear` routes must be reachable
from the public internet on this factory's service port for a suspended run to
wake on its own. Run a tunnel, put the URL in `jigs.yml` as `ingress_url`,
re-bind each target repo with `GITHUB_TOKEN` set, and create a Linear webhook
for `Comment` resources. `docs/setup.md` has the exact commands and the
org-level alternative. Without ingress everything still works; a suspended run
just needs `jigs poke <run>` to notice its answer.

## Upgrading a factory later

```sh
jigs upgrade                # or: jigs upgrade --to <version>
```

bumps `@salimhamed/jigs`, runs `jigs up`, then the factory's own typecheck. A
typecheck error in `steps/jigs.ts` — a block call missing an argument, or an
import with no such member — is a step the release added: it needs a wrapper
there, and `author.md` covers writing one. An install failure naming
`@workflow/web`, `@workflow/world-postgres`, `workflow` or `zod` is a release
that moved a runtime peer: move the same pin in the factory's `package.json`
and run `jigs upgrade` again. A factory still installing jigs from a checkout
(`link:` entries, or the old `jigs` / `@jigs/service` names) is refused;
switch it to the published package first. So is a factory still depending on
`@salimhamed/jigs-service`, retired in 0.3.0: drop that line from
`package.json` and rewrite every `@salimhamed/jigs-service/X` import to
`@salimhamed/jigs/X` first.

pnpm verifies the whole lockfile against its `minimumReleaseAge` policy before
it resolves anything, so a dependency is still age-checked on the very install
that removes it. Leave a recently published package's
`minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` until that install
has run, then drop the entry. Both factories hit this moving off
`@salimhamed/jigs-service`.
