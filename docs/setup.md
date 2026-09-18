# Setting up jigs

Two parts, and the split is the point: the machine is set up once, and then
every factory repo is set up the same way, on its own ports, against its own
World. Nothing below is global except part 1.

## Part 1 — the machine (once)

- **Node >= 24** and **pnpm**. If node comes from a version manager, make sure
  the shell that runs `jigs up` has it on `PATH` — the service is spawned with
  the CLI's own node.
- **docker**, with the daemon running. Each factory brings up its own Postgres
  container; nothing is shared between them.
- **A token that reads GitHub Packages.** jigs ships as `@salimhamed/jigs` on
  GitHub Packages, private like this repo, so pnpm needs a scope route and a
  token in `~/.npmrc`:

  ```
  @salimhamed:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=<token>
  ```

  The token is a **classic** personal access token with `read:packages` and,
  while this repo is private, `repo`; fine-grained tokens cannot read GitHub
  Packages. These two lines serve `pnpm dlx @salimhamed/jigs init`, every
  `pnpm install` and every `jigs upgrade`. A factory's own `.npmrc` carries
  only the scope line — the token never enters a repo. There is no jigs CLI
  to put on `PATH`: each factory installs its own, and `pnpm exec jigs` runs
  it.
- **The agent harness CLIs** a factory's agent steps drive: the Claude Code
  CLI (`claude` on `PATH`, or `JIGS_CLAUDE_EXECUTABLE` in a factory's `.env`)
  and `codex`, each logged in to its subscription — `claude auth login`,
  `codex login`. `jigs doctor` probes both; a trigger's preflight probes the
  ones its workflow declares in `requires.harnesses`, and refuses the run when
  one is missing or logged out.

  Install both yourself and keep them on the `PATH` of whatever starts the
  service. The service checks them before it reports ready: if either is
  missing, or `codex` is older than the minimum version the message names, it
  prints what it found and exits. A service does not always get the same
  `PATH` as your shell, so start it from a shell where both CLIs run. There is
  no codex equivalent of `JIGS_CLAUDE_EXECUTABLE`.
- **The AWS CLI v2**, if any workflow declares `requires: { aws: true }`
  alongside its bindings and harnesses: preflight probes the service's
  `AWS_PROFILE` with `aws sts get-caller-identity` and refuses the run when it
  resolves nothing — `aws sso login --profile <profile>`.
- **A tunnel tool**, if any factory will receive provider webhooks:
  `tailscale` (funnel) or `cloudflared`. Installed once, run per factory.
- **`loginctl enable-linger "$USER"`** for lights-on: services started by
  `jigs up` are detached from the terminal, but a user session manager still
  reaps them at logout without lingering.

There is no persistent systemd unit and no `~/.config/jigs/service.env`. Both
assumed a single global service; supervision is now a pidfile per factory under
the jigs data dir, and the environment is the factory's own `.env`. On Linux,
each start enters a transient user scope. An installed unit per factory would
mean the CLI generating and installing units, and every repair instruction
growing a "which one" — `jigs service restart` is the whole answer instead.
The service is a host process on purpose: it drives the
operator's `claude` and `codex` logins, the AWS SSO cache and the git clones
([ADR 0017](adr/0017-single-package.md)).

**Upgrading.** `jigs upgrade` in the factory: it normalizes jigs' release-age
exclusion, then moves the jigs pin to the latest release (`--to-version <version>`
picks one). It runs `jigs up`, whose upgrade path installs the release,
regenerates `jigs.ts` with that installed CLI, and builds and starts the
factory, then runs the factory's own typecheck. This is a single command even
when an older factory excludes an exact jigs version. Review and commit both
the regenerated `jigs.ts` and any `pnpm-workspace.yaml` normalization. A
release that moves one of the four runtime peers — `workflow`,
`@workflow/world-postgres`, `@workflow/web`, `zod` — fails the install by name;
make the same move in the factory's `package.json` and run it again. A release
can also raise the minimum `codex` version; no install will say so, but the
service will at startup, and the fix is to upgrade `codex` on the machine. A
factory made before this release should add
`ignoredOptionalDependencies: ['@openai/codex']` to its `pnpm-workspace.yaml`
and delete any `@openai/codex` dependency or `overrides` entry. A factory still
carrying the `@salimhamed/jigs-service` dependency retired in 0.3.0 is refused:
drop that line and rewrite its `@salimhamed/jigs-service/X` imports to
`@salimhamed/jigs/X` first ([ADR 0017](adr/0017-single-package.md)).

pnpm still verifies the whole lockfile against its `minimumReleaseAge` policy
before it resolves anything. `jigs upgrade` keeps every jigs version covered
by the `@salimhamed/jigs` exclusion; for other recently published packages,
leave their `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` until
that install has run, then drop the entry. Both factories hit this moving off
`@salimhamed/jigs-service`.

**Releasing this repo (once, by whoever owns it).** The package carries
ordinary semver from `0.1.0` on, and nothing here moves it by hand. A PR's
title is a conventional commit — CI rejects one that is not — and merging it
to `main` opens or updates a release-please PR carrying the next version and
the CHANGELOG entries it earned; that PR merges itself once its own checks
pass, the tag and GitHub Release follow, and the same run publishes to GitHub
Packages. The number is a coordinate for `jigs upgrade` and a signal to
you, never an input to a run: no step id carries a jigs version, so a release
does not rename an address just by changing the package version
([ADR 0013](adr/0013-factory-owned-steps.md)), which is what makes automating
it safe ([ADR 0014](adr/0014-release-automation.md)). Two prerequisites live
in GitHub's console rather than in the tree, and the release workflow is inert
without either:

- **A `RELEASE_PLEASE_TOKEN` repository secret.** A fine-grained PAT on this
  repo with **Contents: read and write** (the tags, the CHANGELOGs, the
  version bumps), **Pull requests: read and write** (open and merge the
  release PR) and **Issues: read and write** (release-please manages its own
  labels). It is a PAT rather than `GITHUB_TOKEN` because GitHub raises no
  workflow run for an event `GITHUB_TOKEN` caused: the release PR would get no
  checks to watch, and its squash would never re-run the release
  ([ADR 0014](adr/0014-release-automation.md)). The publish itself uses
  `GITHUB_TOKEN` — nothing waits on an event it raises, and the workflow's
  `packages: write` is the exact grant.
- **Settings → General → "Default to PR title for squash merge commits".**
  Without it a squash's subject is the branch name, every merge parses as a
  non-releasable unit, and the release PR simply never appears — with no error
  anywhere.

## Part 2 — a factory (per repo)

Every step below runs **inside the factory repo**, and every `jigs` is the
factory's own — `pnpm exec jigs …`, or `pnpm jigs …`. Ports are derived from
the factory's path, so two factories on one machine usually differ; if a
number is already in use, edit it in `jigs.config.ts`, `docker-compose.yml` and
`.env` before `jigs up`. The numbers in your own output are the ones to use.

### 1. Scaffold

```sh
mkdir my-factory && cd my-factory && git init
pnpm dlx @salimhamed/jigs init
```

`jigs init` writes `jigs.config.ts`, the pinned package manifest, build and
infrastructure settings, generated `jigs.ts`, and `workflows/hello.ts`.
Hello creates and removes a run directory, then returns its input, without
repository bindings or integration credentials. Existing files are kept.

`jigs.config.ts` combines operating settings and deferred workflow registrations:

```ts
import { defineFactory } from "@salimhamed/jigs";

export default defineFactory({
  service: { port: 8990, dashboardPort: 9090 },
  bindings: {},
  workflows: { hello: () => import("./workflows/hello.ts") },
});
```

Each workflow module exports its declaration as default:

```ts
import type { WorkflowEntry } from "@salimhamed/jigs";

export default {
  workflow: helloWorkflow,
  inputs: helloInputs,
} satisfies WorkflowEntry<typeof helloInputs>;
```

The deferred import lets CLI commands read settings without evaluating workflows.
The built service resolves those declarations to the compiled functions.

`jigs.ts` is generated integration code: factory-local `"use step"` wrappers and
bound blocks such as `reviewTicket`. Commit it, but keep custom code outside it.
`pnpm exec jigs generate` refreshes it from the installed library; a normal build
checks for drift and fails with that command as the repair. `jigs upgrade`
refreshes it automatically after installing the new library.

Workflows import built-in steps and bound blocks from `#jigs`, and factory
modules from `#blocks/…` and `#steps/…`. Those specifiers come from the
`imports` map in the factory's `package.json`, so a file's own depth never
changes how it reaches another. Custom steps live in `steps/`, and custom
coordination lives in `blocks/`. Bind only the capabilities you need with
`bindAgentSteps`, `bindLinearSteps`, or `bindPullRequestSteps`; generated
integration exports `agentSteps`, `linearSteps`, and `pullRequestSteps` for
overrides. Delivery belongs to the copied ship recipe in `blocks/delivery/`,
which imports its durable operations from `#jigs` directly.
Functions such as prompts stay workflow-side and are never durable step inputs.

Renaming a workflow or durable step changes its address. Finish or cancel affected
runs before deploying such a change. Library version bumps alone do not rename
factory-local addresses.

To add the ship recipe, run `jigs recipe add ship`. The command preserves
existing files and reports created/kept paths. Register it manually under
`workflows` with the printed line:
`ship: () => import("./workflows/ship.ts"),`. The workflow, tests, and Linear
block are now factory source to edit freely.

The ship recipe explicitly resolves and claims its Linear ticket, then calls
the library's `deliverChange`. Set implementation and review harnesses/models
separately — a model left unset takes the chosen harness's own default — and choose
the `implementationReviewRounds`, `ciFixAttempts`, and `pullRequestRevisionRounds`
budgets. A delivery returns only after merge; reaching a limit preserves the
branch, posts a ticket note and fails the run. For custom prompts,
ticket sources, human intervention, and individual phases, see [delivery](delivery.md).

The copied `ship` workflow requires a `binding` input and takes its effective
merge policy from the factory default plus that binding's optional `merge.by`
and `merge.method` overrides in `jigs.config.ts`.
After binding a repository, you can make it the input default and add its name to
`requires.bindings`. Declare credential integrations under `requires.integrations`;
other workflows do not need Linear or GitHub credentials merely to use agents.

### 2. Tokens

```sh
cp .env.example .env      # set integration credentials when workflows need them
```

`.env` is this factory's environment file: the service loads it when it
starts, `jigs bind` reads `GITHUB_TOKEN` out of it, and `PORT` comes from
`jigs.config.ts` rather than from here. The `LINEAR_API_KEY` / `GITHUB_TOKEN` slots
are consumed by the suspension blocks (`haltForHuman()` posts Linear
comments, `pullRequestGate()` re-checks PR state), and are validated when declared in the workflow requirements: preflight refuses to create a run when a requirement is unmet,
reporting every failure with its repair. `jigs doctor` runs the same checks
without a launch.

`WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and `WORKFLOW_POSTGRES_URL`
come filled in; leave them. The service refuses to start when the URL is
unset: the worktree registry lives in that database, so there is no
registry-less mode. (At `workflow@4.8.4` the filesystem World would not start
from a production bundle anyway: `Invalid version string: "bundled"`.)

Skipping the copy is allowed — `jigs up` copies `.env.example` itself when
there is no `.env` and tells you which slots are empty. Hello can run without
these integration tokens; ship requires them.

### 2a. Which GitHub identity jigs uses

`github.identity` in `jigs.config.ts` says who jigs is on GitHub. There are two
modes, and they are chosen once, at `jigs init --github-identity-mode pat|app`.

**`pat` — jigs is you.** The `GITHUB_TOKEN` in `.env` is your own personal
access token, so every pull request jigs opens has you as its author.

```ts
github: { identity: { mode: "pat" } },
```

GitHub refuses to let an author approve or request changes on their own pull
request, so on a pull request jigs opened those buttons are unavailable to you.
Sending work back is what still works — an inline review comment, or a comment
on the pull request conversation, both of which wake the run. A `COMMENTED`
review's summary body wakes it too. To let jigs merge in this mode, use the
`label` approval signal below.

**`app` — jigs is a bot.** jigs mints an hourly installation token from a
GitHub App's private key, so pull requests come from `<app-slug>[bot]` and you
approve them like anyone else's.

```ts
github: {
  identity: {
    mode: "app",
    appId: 4958325,
    installations: { salimhamed: 162033982, downstreamimpact: 162665072, Junglescout: 162664894 },
    privateKeyPath: "github-app.private-key.pem",
    operator: "your-github-login",
    coAuthor: "Your Name <you@example.com>",
  },
},
```

To fill that block in — `jigs init --github-identity-mode app` takes all of it on the
command line, so the scaffold loads on the first `jigs up`:

```sh
jigs init --github-identity-mode app \
  --github-app-id 4958325 --github-app-installation salimhamed=162033982 \
  --github-app-installation downstreamimpact=162665072 --github-app-installation Junglescout=162664894 \
  --github-app-private-key-path github-app.private-key.pem --github-operator-login your-github-login \
  --git-co-author "Your Name <you@example.com>"
```

Where each value comes from:

1. **Register the App.** GitHub → Settings → Developer settings → GitHub Apps →
   New GitHub App. Give it any name; leave "Request user authorization (OAuth)
   during installation" and "Enable Device Flow" unchecked, and **uncheck
   Active under Webhook** — jigs keeps its own per-repo webhooks, and one App
   registration has only one webhook URL, which two factories cannot share.
2. **Grant these repository permissions**, and nothing else: **Contents**,
   **Pull requests** and **Issues** read & write; **Administration** read-only;
   **Metadata**, **Checks** and **Commit statuses** read; and **Repository
   webhooks** read & write. When
   `merge.by` is `"jigs"` and the factory has bindings, also grant **Actions**
   read so `jigs bind` and `jigs doctor` can verify that the repository has an
   active Actions workflow. The Repository webhooks
   permission lets `jigs bind` create the hook that wakes a parked run; a
   missing permission is named by `jigs doctor`.
3. **`appId`** is the "App ID" on the App's settings page.
4. **`privateKeyPath`** is the `.pem` GitHub generates under "Private keys".
   Save it in the factory repo (`.gitignore` already excludes
   `*.private-key.pem`) and `chmod 600` it; `jigs doctor` fails on a looser
   mode, because anyone who can read it can act as the App.
5. **Install the App** on the repos you bind (App settings → Install App). The
   installation's URL ends in its id: add it under the account login in **`installations`**. A
   repository admin can install an App on repos they administer as long as it
   asks for no organization permissions and org policy allows it.
6. **`operator`** is your own GitHub login. An installation token does not
   answer `GET /user`, so jigs cannot discover it — and it is what jigs
   assigns the pull request to and names in its first body line, `Requested by
   @you`. **`coAuthor`** is optional: `Name <email>` for a `Co-authored-by`
   trailer on the merge commit. Omit it and no trailer is added.

The binding's remote selects its account: the owner in
`git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)`, or
`ssh://git@github.com/owner/repo.git`. Account matching ignores case. Every
GitHub binding must have a covering installation; bind, doctor and run preflight
name an uncovered account and the `installations` entry to add.

To add another organization: install the App, copy the id from the installation
URL, add one line to `installations`, then run `jigs up`.

If organizations require different Apps, replace `github.identity` with
`github.identities`, a nonempty list of App entries:

```ts
github: {
  identities: [
    { mode: "app", appId: 4958325, privateKeyPath: "personal.private-key.pem",
      installations: { salimhamed: 162033982 }, operator: "salimhamed" },
    { mode: "app", appId: 1234567, privateKeyPath: "org.private-key.pem",
      installations: { exampleOrg: 7654321 }, operator: "salimhamed",
      coAuthor: "Salim Hamed <salimhamed@gmail.com>" },
  ],
},
```

Each App has its own key, installations, operator and optional co-author. No two
entries may claim the same account, and PAT identities cannot appear in the
list. Configure exactly one of `identity` or `identities`.

Existing single-App factories can keep `installationId`: it continues to select
that installation for every binding, and `jigs upgrade` requires no config edit.
Configure exactly one of `installationId` or a nonempty `installations` map.
`jigs init --github-app-installation <account>=<id>` is repeatable;
`--github-app-installation-id <id>` scaffolds the legacy shorthand.

In `app` mode jigs pushes over HTTPS with the installation token, supplied to
that one `git push` and never written to `.git/config` or any log. In `pat`
mode it pushes over the binding's own SSH remote, as you. Either way the commit
is the one your worktree made, with your author, committer and signature
intact.

Sharing a login does not confuse jigs about who said what. Every comment jigs
posts carries a hidden HTML comment naming the workflow, the run and the
comment it answers, and that marker — not the author — is how jigs tells its own
words from yours. It reads the same whether jigs runs as a bot or as you. You
will not see the markers in GitHub's UI, and editing a comment of yours that
jigs answered asks the question again, which is usually what you meant.

#### Who merges, and on what signal

`merge` in `jigs.config.ts` is this factory's policy, independent of the
identity above. Nothing derives one from the other while jigs is running; `jigs
init` simply writes the pairing that works for the mode you chose.

```ts
merge: {
  by: "human",                    // or "jigs"
  method: "squash",               // or "merge", or "rebase"
  approval: { kind: "review" },   // or { kind: "label", name: "jigs:approved" }
},
```

- **`by`** — `"human"` means jigs watches the pull request and answers
  feedback, and you press Merge. `"jigs"` means jigs merges it itself once it
  is ready. A binding may override this field for its repository.
- **`method`** — GitHub's three, and it decides what lands on the base branch.
  A binding may override this field for its repository.
  With `squash`, jigs uses the pull request title for the new commit's title;
  GitHub makes the pull request's author the commit's author, so in `app` mode
  the bot is the author and `coAuthor` is how you keep the credit. With `merge`,
  jigs uses the pull request title for the merge commit, while your branch
  commits land untouched alongside it. With `rebase`, GitHub accepts no merge
  message: each branch commit keeps its author but is rewritten by the merging
  credential and loses its signature.

  For `squash` and `merge`, jigs supplies a body only in `app` mode when
  `coAuthor` is configured. Supplying it replaces the body GitHub would
  generate, so jigs explicitly preserves a one-commit branch's body or every
  subject and body from a multi-commit branch, then appends the
  `Co-authored-by` trailer. That keeps content such as `BREAKING CHANGE:`
  footers. In `pat` mode, or when `coAuthor` is omitted, jigs supplies no body
  and leaves body generation to GitHub and the repository's configuration.
- **`approval`** — what counts as your consent. `{ kind: "review" }` is an
  APPROVED GitHub review of the current commit; a push withdraws it, and it is
  only reachable when jigs is not the pull request's author, so it is the `app`
  mode's signal. `{ kind: "label", name: "…" }` is a label on the pull request,
  which is the only consent you can give your own pull request, so it is the
  `pat` mode's signal. The label means "merge whenever ready": it survives
  later pushes and jigs never removes it, so a revision you have not looked at
  can merge on its strength.

jigs merges only when the configured signal is present, GitHub itself reports
the pull request mergeable — its own verdict, which already folds in conflicts,
required checks and required reviews — the pull request is not a draft, and CI
is green. GitHub is the authority on mergeability; jigs does not re-derive it.
The merge call pins the commit jigs judged ready, so a push that lands first is
refused rather than merged over, and jigs re-reads the pull request and decides
again.

The CI condition is jigs' own, and it means at least one check that has
finished and passed. GitHub reports a repository that requires no checks as
mergeable with no build at all, including in the seconds before CI registers,
so without it a labelled pull request could merge ahead of its own build. The
consequence is worth saying plainly: **jigs never merges in a repository with
no CI.** Set that binding's `merge.by` to `"human"` there.

A few merge states you will see jigs wait on rather than merge:

- **`behind`** — the repository requires branches to be up to date with the
  base. jigs waits; it does not update the branch for you, and doing that
  automatically is a follow-up rather than something this does today.
- **`blocked`** — a required review or a required check is missing. Worth
  knowing: a `label` approval cannot satisfy a native "require approvals" rule,
  so on a repository with one, a `pat`-mode pull request stays `blocked` for
  ever and `merge.by: "jigs"` never fires. Label approval is for repositories
  whose rules do not require a review.
- **`has_hooks`** and **`unknown`** — treated as not ready, and rechecked on
  the next wake.

`jigs doctor` prints the effective policy for each binding, so what a factory
will actually do is readable without opening its config. For bindings whose
effective `merge.by` is `"jigs"`, `jigs bind` and `jigs doctor` also report
when that repository has no CI, disables the configured merge method,
requires reviews that label approval cannot satisfy, or lacks the configured
approval label. Bind creates or restores that configured label; doctor reports
it missing and directs you to re-run bind. The remaining checks only read
repository settings.

Jigs only reports repository governance; it never changes branch protection or
rulesets. Run `jigs doctor`, apply each listed repair in the repository's GitHub
settings, and run `jigs doctor` again. Repeat that loop until every check is
green. Jigs waits for CI and for the approval signal itself, so it never asks a
repository to require either of them of its own contributors; what it cannot
work around is a required-review rule under label approval, because GitHub does
not count a label as a review. The report reads both classic branch protection
and rulesets and names the relevant GitHub settings page for every mismatch.

### 3. Up

```sh
pnpm install              # once: the factory's own jigs lands in node_modules/.bin
pnpm exec jigs up --no-doctor
```

For bare hello setup, `--no-doctor` skips the final doctor pass, which checks
GitHub credentials even when the workflow does not use GitHub. Postgres and the
service's machine prerequisites (including both agent CLIs) still apply. Once
integration credentials are configured, use plain `jigs up` and `jigs doctor`.


`jigs up` is the commands a human used to type after `jigs init`, run in
order, each idempotent, each its own line:

```
ok   locate (3ms) — /home/you/my-factory
ok   env (1ms) — copied .env.example to .env
     LINEAR_API_KEY, GITHUB_TOKEN empty in .env — fill them in before a workflow needs them
ok   install (4.7s)
ok   compose (2.1s)
ok   bootstrap (1.3s)
ok   build (1.9s)
ok   service (12ms)
ok   ready (1.8s)
skip doctor — --no-doctor
my-factory-2286ac2a is up at http://localhost:8990 — dashboard http://localhost:9090
```

- **env** copies `.env.example` to `.env` if there is none and reports the
  credential slots still empty.
- **install** is `pnpm install`, reading `@salimhamed/*` from GitHub Packages
  through your `~/.npmrc`.
- **compose** is `docker compose up -d --wait`: this factory's own Postgres
  World, on the port `jigs init` chose.
- **bootstrap** applies the SDK's migrations and the queue schema to that
  World, with the URL from `.env` handed to it explicitly, then applies jigs’
  versioned SQL from its packaged `migrations/` directory using the separate
  `jigs_drizzle.jigs_migrations` history. Both are idempotent.
- **build** is `jigs build`: this factory's workflows compiled into
  `.output/server/index.mjs` with the factory's own nitro and its own copy of
  the SDK — the copy that compiles the step ids has to be the copy that
  registers them.
- **service** starts the service if none is running; if one is, it restarts
  it only when the built bundle differs from the one the process started from
  (`--restart-service` forces it). A restart over in-flight runs asks first —
  `--force` skips the question, and without a terminal it refuses instead.
- **ready** waits for `/health` to report the service ready, printing each
  boot phase as it changes (`booting: cloning forge`) and watching the pid
  alongside: the service clones every binding and opens the World before it
  is ready — a minute the first time — and a remote it cannot reach exits the
  process, which fails the step at once with the log that explains it. A boot
  still not done after five minutes fails it too and leaves the process
  running for `jigs service stop`.
- **doctor** is `jigs doctor` against the service that just came up
  (`--no-doctor` skips it).

The first step that fails prints `FAIL <step>: <why>` and the repair on the
next line, and `up` exits 1 there; fix it and run `up` again. Nothing before
the failure is redone in any way that matters — an unchanged factory installs,
migrates and restarts nothing, which is why **`jigs up` is also the command
after every change**: edit a workflow, `jigs up`, and the rebuild and restart
happen only if the bundle moved.

The pieces are still there on their own — `jigs build`, `jigs service
start|stop|restart|status|logs` — for when you want one of them without the
rest. `start` does the same wait `ready` does, so a `jigs ps` or `jigs doctor`
fired straight after it reaches a working service. `stop` sends SIGTERM: the
service stops taking work, waits up to eight seconds for what is in flight,
and exits; the CLI escalates to SIGKILL only past ten. An agent step still
running at that point is not cut short by the wait — the process exits after
the backstop and the queue retries the job later. `jigs service logs` is the
service's own stdout, which is not a run's history (step 6). `jigs service
status` prints the service and dashboard URLs whenever you need them again.

#### Step ceiling

A step runs **for as long as it takes**. The service prints the ceiling it
started with:

```
[service] step ceiling: uncapped on the step route at http://localhost:8990; undici defaults elsewhere
```

The World runs every step over HTTP against the service's own port, and node's
five-minute default was cutting long agent steps off and launching a second
agent into a worktree the first was still working in. The service scopes a
no-timeout HTTP dispatcher to its own origin — so the step self-invocation
waits, and every other request it makes (GitHub, Linear, the agent providers)
keeps node's defaults and still fails against a wedged server.

A worktree admits one agent at a time: a second one is refused, not queued.

### 4. Bind target repos

```sh
jigs bind git@github.com:owner/repo.git
jigs bindings
jigs service restart      # or jigs up --restart-service
```

A binding is a name in `jigs.config.ts` mapped to a target repo's **remote URL**.
jigs keeps its own bare clone per binding, at
`~/.local/share/jigs/bindings/<factory>/<binding>/repo.git`, and cuts every
agent worktree from it — your own checkout of the repo is not involved at all.
Workflows name bindings; the runtime provisions worktrees from them.
Without `--binding-name`, bind reuses the first configured binding whose remote URL is
an exact match; only an absent remote creates a repo-name-derived binding. An
explicit `--binding-name` bypasses remote matching and can create another binding for
the same remote.

**The clones are made when the service starts**, not when a run asks for a
worktree, so the first start after a bind pays for them — seconds for a small
repo, up to a minute for a large one, and the service logs a line per binding
as it goes. A binding added while the service is running therefore needs the
restart above before any run can name it; `jigs bind` says so, and
`jigs doctor` reports a binding with no clone yet. (Binding before the first
`jigs up` works too and saves the restart; the order here is only the one a
newcomer meets.)

`jigs bind` creates or verifies jigs' repository furniture: the webhook, plus
the configured approval label when `merge.approval.kind` is `"label"`. In PAT
mode it reads `GITHUB_TOKEN` from this factory's `.env`, and an exported one
wins for that one command — a convenience of bind's, not the factory's rule:
the service reads `.env` alone, so a token that only ever lives in your shell
leaves the running factory without one, and bind notes it. A classic PAT needs
`admin:repo_hook` for the webhook and `repo` (or `public_repo` for a public
repository) to create the label.

A factory with an `ingressUrl` in its `jigs.config.ts` (step 5) and no usable token
is half configured — an ingress nothing posts to, a PR gate that never wakes —
so `jigs bind` **fails** there rather than noting a skip, and says the repair.
GitHub rejecting the token fails the same way. Fix the token and run the same
`jigs bind` again: the binding it already recorded stands, and the webhook
registration is create-or-verify, so re-running is how you repair. A factory
with no `ingressUrl` skips the webhook; it still needs a usable identity when
label approval is configured, because bind creates or verifies that label.

The binding also declares what its worktrees need before an agent can work in
them — files to copy in, commands to run:

```ts
bindings: {
  forge: {
    remote: "git@github.com:downstreamimpact/Forge.git",
    copy: [".env"],
    postCreate: ["mise exec -- npm ci"],
    hookTimeoutMinutes: 20,
  },
},
```

**A `copy:` entry is a path relative to the binding's own `bindings/<name>/`
directory in this factory repo, and lands at that same relative path inside the
worktree.** So the file above is `bindings/forge/.env` here and arrives as
`.env` at the worktree root; `config/app.local` there arrives as
`config/app.local`. One directory per binding, mirroring the target repo's
tree, so nothing needs a mapping syntax — an entry that reaches outside it, or
that matches nothing, fails the worktree request by naming the binding and the
entry rather than handing an agent a tree missing its secrets.

`jigs bind` and `jigs unbind` edit the TypeScript syntax tree. For automatic
editing, declare `bindings` directly as an object with ordinary properties.
If it is computed, spread, or otherwise ambiguous, the command explains the
unsupported expression and leaves the file untouched, before any webhook writes.
Computed configuration remains valid to load; it must be edited manually.

All three provisioning keys are optional and hand-edited: `jigs bind` writes
`remote:` and nothing else. `postCreate` commands run in the worktree, fail
fast, and share one `hookTimeoutMinutes` budget (default 10).

Secrets therefore live in this factory repo, gitignored: put the `.env`-class
files under `bindings/<name>/` and add `bindings/*/.env` to the factory's
`.gitignore` — the directory itself can hold committed non-secret files. They
sit next to the workflows that need them, on the machine that provisions the
worktrees, without ever being committed.

`jigs bindings` prints each binding's clone path and whether the clone exists,
and `jigs unbind` leaves the clone on disk for you to `rm -rf`.

### 5. Webhook ingress

The service's `/ingress/github` and `/ingress/linear` routes receive provider
webhooks: signature-verified, stateless, and safe to miss — every wake is
re-checked against the provider, and `jigs poke <run>` covers any delivery
that never arrived.

#### Tunnel (one-time per factory, manual)

The ingress must be reachable from the public internet, on **this factory's**
service port:

```sh
tailscale funnel --bg <servicePort>
```

The printed `https://<machine>.<tailnet>.ts.net` URL is this factory's ingress
URL. Alternative: `cloudflared tunnel --url http://localhost:<servicePort>`
(or a named cloudflare tunnel for a stable hostname). One tailnet machine can
funnel a limited number of ports; factories that will never receive webhooks
need no tunnel at all.

Put the URL in this factory's `jigs.config.ts`:

```ts
ingressUrl: "https://<machine>.<tailnet>.ts.net",
```

#### GitHub (per target repo)

(Re-)bind each target repo — `jigs bind` creates the repo webhook from
`ingressUrl`, verifies it on later binds, and repairs drift. It needs
hook-administration rights, and fails without them: in `pat` mode that is a
`GITHUB_TOKEN` with `admin:repo_hook` in this factory's `.env` or exported in
the shell, and in `app` mode it is the App's **Repository webhooks: read &
write** permission, granted on the App and accepted on the installation. The signing secret is the one
thing here that is not per factory: one file per machine at
`~/.local/share/jigs/github-webhook-secret`, generated on the first bind and
shared by every factory's repo webhooks. The service reads
the same file, or `GITHUB_WEBHOOK_SECRET` from `.env` if set. Each factory owns
the hook at its exact URL; changing its hostname creates a new hook and leaves
the old one for you to delete by hand.

Manual alternative: one org-level webhook (org settings → Webhooks) pointed at
`<ingressUrl>/ingress/github`, content type `application/json`, events
`pull_request`, `pull_request_review`, `pull_request_review_comment`,
`issue_comment` and `check_suite`, secret from that same file — covers every
repo without per-repo binds. Note that it points at one factory: an org-level
hook and several factories do not mix.

#### Linear

Create a webhook in Linear (Settings → API → Webhooks) pointed at
`<ingressUrl>/ingress/linear` with resource types `Comment` only. Put its
signing secret in this factory's `.env` as `LINEAR_WEBHOOK_SECRET` and
`jigs service restart`.
`jigs doctor` verifies that this exact webhook exists and is enabled.

#### Missed deliveries

GitHub does not retry a delivery it failed to make, and a tunnel that drops one
connection in three is a real thing that happens. So the webhook is the fast
path, not the only one: the service re-reads every pull request a run is parked
on every five minutes, and once more when it starts. A lost delivery costs
minutes, not the whole wait. Each sweep logs one line:

```
[nudge] pull requests: 2 held, 2 nudged, 0 mid-turn, 0 gone, 0 failed
```

`gone` is a run that has moved on since the listing, which is ordinary;
`failed` is a pull request that has lost its floor, and each one is warned
about by name. A sweep that cannot run at all logs a warning instead; while
that is happening, no lost delivery is recovered, so it is worth reading. A run
that is mid-turn is left alone and swept on the next pass.

```sh
jigs poke <run>
```

still wakes a suspended run by hand, over the same code path, when five minutes
is too long to wait.

### 6. Operating runs

```sh
jigs run <workflow> --input ticket=AGE-123
jigs ps
jigs logs <run>
jigs cancel <run> [--force] [--discard-worktrees]
jigs sweep [<path>] [--force]
```

jigs narrates every workflow milestone in `jigs logs`. A workflow body that
needs `console.log` is missing a jigs-side line; file a ticket instead of
adding one to the workflow.

Factories upgrading past 0.1.4 must pass the injected Linear `identifier` as
the second argument to `claimTicket`, or adopt the `ticket=` input shown above.

Every verb dials the service of the factory you are standing in;
`--service-url <url>` / `JIGS_SERVICE_URL` overrides that. `--input` values are
read as JSON with the raw string as the fallback, so `askHuman=true` is a
boolean and `AGE-123` is a string; a value the workflow's `inputs` schema
rejects fails in the CLI, before any run is created.

`<run>` is a run id, a unique id prefix, or the ticket the run claimed — an
ambiguous prefix lists its candidates instead of guessing. A ticket named by
its identifier (`AGE-123`) is resolved against Linear first, since the claim
itself is keyed on the issue's UUID.

`jigs cancel` is the escape hatch when a run holds a resource nobody is coming
back for: cancelling releases every hook it claimed, so the same ticket can be
launched again. A suspended run cancels silently — no process is involved —
while a run still in flight is confirmed first, and `--force` skips that
prompt when there is no terminal to answer it. By default, cancel names the
worktrees it leaves behind. `--discard-worktrees` also removes that run's worktrees after
the cancellation succeeds; branches containing unmerged commits are kept.

A workflow requests release as its last successful action with `await release()`.
The factory's `release: { onSuccess: "release", onFailure: "keep" }` default can
be overridden by a workflow entry, then by a callsite policy. Release reports
which worktrees, branch refs and scratch directory were removed or retained.
Dirty unmerged work stays; only a proven zero unmerged-commit count permits
branch deletion. Squash-merged branch refs may remain because ancestry does
not prove their work landed.

Failed runs leave their files until manual `jigs sweep`; waiting runs keep
them. Sweep includes scratch directories even for runs with no worktree, and
requires positive terminal-run evidence before removing a scratch directory.
It never removes a live or suspended run's resources. Nothing runs in the
background, and release belongs in neither `finally` nor a catch.

Sweep reads the current workflow/factory policy; callsite overrides are not
persisted for later cleanup. `onFailure: "keep"` retains terminal resources
until explicit confirmation or force. `onFailure: "release"` permits an
operator-requested clean pass; it does not schedule one. Worktrees remain
visible in `jigs ps`; sweep labels scratch entries as `run-directory`.
On a terminal, `jigs sweep` asks per resource, with a stronger warning for
uncommitted work. Without a terminal it reports only. `jigs sweep --force`
removes eligible terminal resources without asking, including dirty trees;
`jigs sweep <path>` scopes that approval to one resource. Branches still need
positive ancestry evidence even with force. Each removed worktree line reports
whether its branch was deleted or kept, including its unmerged commit count.

**Recurring runs.** A workflow can also fire on a schedule this factory
declares beside its workflows, in `jigs.config.ts`:

```ts
export default defineFactory({
  service: { port: 8990, dashboardPort: 9090 },
  workflows: {
    "weekly-report": () => import("./workflows/weekly-report.ts"),
  },
  schedules: {
    "monday-report": {
      workflow: "weekly-report",
      cron: "0 9 * * 1",
      inputs: { audience: "team" },
    },
  },
});
```

Five cron fields, read in the service host's local time — UTC on the host in
this example, which is why the timestamps below carry a `Z`. `jigs up` to pick
the schedule up (the bundle changed, so it rebuilds and restarts); the
service's own log then names what it scheduled:

```
[schedule] monday-report scheduled: 0 9 * * 1 → weekly-report, next 2026-09-07T09:00:00.000Z
```

`jigs ps` prints `RUN WORKFLOW TICKET STATUS TRIGGER AGE ACTIVITY WAITING`, then
a schedule table under the runs. Every run the schedule fired carries its name
in the `TRIGGER` column:

```
RUN                              WORKFLOW       TICKET  STATUS   TRIGGER                 AGE  ACTIVITY  WAITING
wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  weekly-report  -       running  schedule:monday-report  2m   10s       -

SCHEDULE       WORKFLOW       CRON       NEXT                      ACTIVE
monday-report  weekly-report  0 9 * * 1  2026-09-14T09:00:00.000Z  wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM
```

Each fire is an ordinary trigger: the inputs are validated against the
workflow's schema, preflight runs, and a failure is a line in
`jigs service logs` with no run created. A tick whose last run is still active
is skipped and says so, and a tick missed while the service was down is not
made up — the next occurrence is computed from now. A schedule naming a
workflow that does not exist, a cron that does not parse, or inputs the schema
rejects is refused at startup with its repair, and `jigs doctor` reports the
same thing on demand.

### 7. Run history (the dashboard)

The service hosts the SDK's observability UI — run history, step attempts,
events — on the port this factory's `jigs.config.ts` declares beside its service
port:

```ts
service: { port: 8990, dashboardPort: 9090 },
```

`jigs init` writes both, from ranges that cannot overlap. `dashboardPort` is
required — a factory without one refuses to parse, naming the field — and both
are committed numbers, so either can move. `jigs up`'s last line and
`jigs service status` print the address:

```
started my-factory-2286ac2a: pid 91234 at http://localhost:8990
dashboard: http://localhost:9090
```

`jigs run` and `jigs logs <run>` print the run's own page there
(`http://localhost:9090/run/<run>`), and `jigs logs` follows it with the step
timeline and any queue job that died holding the run's resume, each with the
SQL that puts it back on the queue:

```
STEP                                   STATUS     ATTEMPT  STARTED                   TOOK     ERROR
step//./jigs//provisionWorktree  completed  1        2026-09-04T10:00:00.000Z  1.2s

dead job 4128 (jigs:workflow) after 3 attempts: Queue execution failed (404): Not Found
  requeue: select graphile_worker.reschedule_jobs(array[4128]::bigint[], run_at := now(), attempts := 0)
```

`jigs ps` and `jigs logs` both report such a run as `stalled` rather than
`running`: it holds no suspension, has no step in flight, and nothing is
coming to move it.

**Never run a standalone `workflow web` against a live World without
`WORKFLOW_LOCAL_BASE_URL` pointing at that factory's service** — opening the
World starts a queue worker in that process too, and it will steal queue jobs
and deliver them to its own port, where there is no workflow route. That is
what the hosted dashboard exists to avoid; if you must run the CLI anyway:

```sh
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:<postgresPort>/jigs \
WORKFLOW_LOCAL_BASE_URL=http://localhost:<servicePort> \
  pnpm exec workflow web --backend @workflow/world-postgres
```
