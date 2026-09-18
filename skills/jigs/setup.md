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
- The agent harness CLIs the factory's workflows will drive — `claude` and
  `codex` — each logged in to its subscription, and both on the `PATH` of
  whatever starts the service. The service will not start without them, or
  with a `codex` below the minimum version it prints. A service does not always
  get the same `PATH` as the shell. `JIGS_CLAUDE_EXECUTABLE` can point at a
  `claude` that is not on `PATH`; `codex` has no equivalent.
- The AWS CLI, only if a workflow will declare `aws: true`.
- A tunnel tool (`tailscale` or `cloudflared`), only if the factory will receive
  provider webhooks.
- On Linux with systemd, run `loginctl enable-linger "$USER"` once so factory
  services survive the last login session ending. `jigs doctor` verifies it.

jigs is one package on GitHub Packages, `@salimhamed/jigs`, pinned by the
factory to a version. Nothing is cloned and nothing is installed globally:
inside a factory, `jigs` means `pnpm exec jigs`.

## 1. Scaffold the factory

```sh
mkdir my-factory && cd my-factory && git init
pnpm dlx @salimhamed/jigs init                  # jigs acts as the operator
pnpm dlx @salimhamed/jigs init --identity app   # jigs acts as a GitHub App
```

Choose the identity now: it is written into `jigs.config.ts` as
`github.identity`, together with the `merge.approval` signal that works with it
(a `jigs:approved` label for `pat`, a GitHub review for `app`). Section 2a
covers both. Changing it later is a config edit, not a re-scaffold.

`jigs init` writes `jigs.config.ts`, a package manifest pinned to the CLI's
version, build settings, Docker Compose, `.env.example`, and the factory's
trivial `hello` workflow. Optional recipes are copied in separately.
It also writes the committed generated integration, `jigs.ts`.

The printed ports are derived from the factory path. Two factories can still
collide; use the printed numbers and adjust them if already occupied.

Existing files are preserved. Custom workflows, blocks and steps belong to
the factory; `author.md` covers extending them. Keep custom code outside
`jigs.ts`: `jigs generate` refreshes that entire file, and builds refuse drift.
Finish or cancel affected runs before deploying workflow or step renames.

## 2. Tokens

```sh
cp .env.example .env
```

The scaffold's `hello` workflow needs no integration credentials.
Fill in `LINEAR_API_KEY` and, in `pat` mode, `GITHUB_TOKEN` before the first ship
run: a workflow that declares either integration cannot start a run without a
working credential. `WORKFLOW_TARGET_WORLD` and `WORKFLOW_POSTGRES_URL` come
filled in and should be left alone.

## 2a. GitHub identity and merge policy

Both live in `jigs.config.ts` and are independent of each other; `jigs init`
writes a matching pair and nothing derives one from the other at run time.

**`pat`** — jigs is the operator. `GITHUB_TOKEN` in `.env` is all it needs, and
`jigs bind` wants a classic PAT with `admin:repo_hook` plus `repo` (or
`public_repo` for a public repository). GitHub refuses to let
an author approve their own pull request, so `merge.approval` is a label:
`{ kind: "label", name: "jigs:approved" }`, meaning "merge whenever ready" —
it survives later pushes and jigs never removes it.

**`app`** — jigs is `<app-slug>[bot]` and the operator approves its pull
requests normally. It needs, in `github.identity`: `appId`, `installationId`,
`privateKeyPath` (the `.pem`, `chmod 600`, gitignored) and `operator` (the
human's login — an installation token cannot answer `GET /user`). Optional
`coAuthor` is `Name <email>` for a `Co-authored-by` trailer on merge commits.
Grant the App exactly: Contents, Pull requests and Issues **read & write**;
Administration, Metadata, Checks and Commit statuses **read**; and
**Repository webhooks read & write**. When `merge.by` is `"jigs"` and the factory has bindings, also grant
Actions **read** so `jigs bind` and `jigs doctor` can verify that the
repositories have an active Actions workflow. Permissions have to be accepted on the
installation after they are granted on the App. Register the App with its own
webhook **off**; jigs keeps per-repo webhooks, and one App registration has
only one webhook URL.

Factory `merge` states the default policy: `by` (`jigs` or `human`), `method`
(`squash`, `merge` or `rebase`), and `approval`. A binding may override `by`
and `method`; approval stays factory-level. jigs merges only when the signal is
present, GitHub reports the pull request mergeable, CI is green (at least one
check, all of them passed), and it is not a draft — so **jigs never merges in a
repository with no CI**; set that binding's `merge.by` to `"human"` there. A `label` approval
cannot satisfy a native "require approvals" rule, so on a repository carrying
one, `merge.by: "jigs"` in `pat` mode never fires. A `behind` pull request
(branches must be up to date) is waited on, not updated. `jigs doctor` prints
the identity and the effective policy per binding:

```
ok   GitHub identity: jigs acts as jigs-app-dev[bot]; operator salimhamed
ok   merge policy: repo: jigs merges with squash once GitHub reports it mergeable and an approving GitHub review of the current commit is present
```

## 3. Up

```sh
pnpm install          # once, so the factory's own jigs exists
pnpm exec jigs up --no-doctor
```

For bare hello setup, `--no-doctor` skips the final doctor pass, which checks
GitHub credentials even when the workflow does not use GitHub. Postgres and the
service's machine prerequisites (including both agent CLIs) still apply. Once
integration credentials are configured, use plain `jigs up` and `jigs doctor`.


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
skip doctor — --no-doctor
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

## 4. Add a recipe and bind its target repos

The bare scaffold registers `hello`, which creates and removes a run directory
and echoes its input: `jigs run hello --input message=hello`.
For ticket delivery, run `jigs recipe add ship` (or `jigs recipe list` to list
choices). It copies source and reports created/kept files without overwriting.
Manually add its printed registration under `workflows` in `jigs.config.ts`:
`ship: () => import("./workflows/ship.ts"),`. Configure the recipe's integration
credentials and harnesses, then bind a target. Copied recipes are factory code.

```sh
jigs bind git@github.com:owner/repo.git
jigs bindings
jigs up                  # rebuild and restart for the changed configuration
```

A binding is a name in `jigs.config.ts` mapped to a target repo's remote URL. jigs
keeps its own bare clone per binding under
`~/.local/share/jigs/bindings/<factory>/<binding>/repo.git` and cuts every
worktree from it — the operator's own checkout is not involved. The service
makes those clones when it starts, so the restart above is what makes a new
binding usable (seconds, up to a minute for a large repo); `jigs doctor`
reports a binding with no clone yet.

Binding commands edit the TypeScript syntax tree. They require an unambiguous
literal `bindings` object for automatic edits. Unsupported syntax produces a
clear repair message before any configuration or webhook writes; edit computed
configurations manually.

The binding also carries how its worktrees are provisioned — `jigs bind` writes
`remote:` only, the rest is hand-edited and optional:

```ts
bindings: {
  forge: {
    remote: "git@github.com:owner/Forge.git",
    copy: [".env"],
    postCreate: ["npm ci"],
    hookTimeoutMinutes: 20,
  },
},
```

A `copy:` entry is a path relative to the binding's own `bindings/<name>/`
directory in the factory repo and lands at that same relative path in the
worktree — `bindings/forge/.env` above arrives as `.env` at the worktree root.
An entry that matches nothing, or that reaches outside that directory, fails
the worktree request by name. `.env`-class files therefore belong in the
factory repo under `bindings/<name>/`, gitignored as `bindings/*/.env`, never
in the target repo.

`jigs bind` creates or verifies jigs' repository furniture: the configured
approval label when `merge.approval.kind` is `"label"`, and the GitHub webhook
when the factory has an `ingressUrl` in `jigs.config.ts`. It uses the configured
identity: in `pat` mode
`GITHUB_TOKEN` from the factory's `.env` — or from the shell for that one
command, which wins there and only there (the service reads `.env` alone) — and
in `app` mode the installation token, which needs the App's Repository webhooks
permission. Without usable hook rights it fails and says
the repair — an ingress with no webhook is a gate that never wakes — and the
retry is the same `jigs bind`: the binding already recorded stands and the
webhook is create-or-verify. A factory with no `ingressUrl` skips the webhook
with a note, but still needs a usable identity when label approval is
configured. Re-running bind also restores a deleted approval label; doctor
reports one that is missing. `jigs unbind` edits the config only; the clone stays on disk.

## 5. Webhook ingress, only if the factory needs it

The service's `/ingress/github` and `/ingress/linear` routes must be reachable
from the public internet on this factory's service port for a suspended run to
wake on its own. Run a tunnel, put the URL in `jigs.config.ts` as `ingressUrl`,
re-bind each target repo (hook-administration rights required), and create a Linear webhook
for `Comment` resources. `docs/setup.md` has the exact commands and the
org-level alternative. Without ingress everything still works; a suspended run
just needs `jigs poke <run>` to notice its answer.

## Upgrading a factory later

```sh
jigs upgrade                # or: jigs upgrade --to <version>
```

normalizes jigs' release-age exclusion, then bumps `@salimhamed/jigs` and runs
`jigs up`. During that `up`, it installs the release, regenerates `jigs.ts`
through the newly installed CLI, then builds and starts the factory. Finally it
checks the factory's custom code. It is the only command needed even when an
older factory excludes an exact jigs version. Review and commit the regenerated
`jigs.ts` and any `pnpm-workspace.yaml` normalization. Fix API errors in custom
code outside `jigs.ts`; refresh generated wrappers with `jigs generate`. An
install failure naming `@workflow/web`, `@workflow/world-postgres`, `workflow`
or `zod` is a release that moved a runtime peer: move the same pin in the
factory's `package.json` and run `jigs upgrade` again. A release can also raise
the minimum `codex` version; the service reports that at startup, and the fix
is to upgrade `codex` on the machine. A factory made before this release needs
`ignoredOptionalDependencies: ['@openai/codex']` in its `pnpm-workspace.yaml`
and should delete any `@openai/codex` dependency or `overrides` entry. A
factory still installing jigs from a checkout
(`link:` entries, or the old `jigs` / `@jigs/service` names) is refused;
switch it to the published package first. So is a factory still depending on
`@salimhamed/jigs-service`, retired in 0.3.0: drop that line from
`package.json` and rewrite every `@salimhamed/jigs-service/X` import to
`@salimhamed/jigs/X` first.

pnpm still verifies the whole lockfile against its `minimumReleaseAge` policy
before it resolves anything. `jigs upgrade` keeps every jigs version covered
by the `@salimhamed/jigs` exclusion; for other recently published packages,
leave their `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` until
that install has run, then drop the entry. Both factories hit this moving off
`@salimhamed/jigs-service`.
