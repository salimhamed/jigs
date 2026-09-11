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
  ones its pipeline declares in `requires.harnesses`, and refuses the run when
  one is missing or logged out.
- **The AWS CLI v2**, if any pipeline declares `requires: { aws: true }`
  alongside its bindings and harnesses: preflight probes the service's
  `AWS_PROFILE` with `aws sts get-caller-identity` and refuses the run when it
  resolves nothing — `aws sso login --profile <profile>`.
- **A tunnel tool**, if any factory will receive provider webhooks:
  `tailscale` (funnel) or `cloudflared`. Installed once, run per factory.
- **`loginctl enable-linger "$USER"`** for lights-on: services started by
  `jigs up` are detached from the terminal, but a user session manager still
  reaps them at logout without lingering.

There is no systemd unit and no `~/.config/jigs/service.env`. Both assumed a
single global service; supervision is now a pidfile per factory under the jigs
data dir, and the environment is the factory's own `.env`. A unit per factory
would mean the CLI generating, installing and naming units, and every repair
instruction growing a "which one" — `jigs service restart` is the whole
answer instead. The service is a host process on purpose: it drives the
operator's `claude` and `codex` logins, the AWS SSO cache and the git clones
([ADR 0017](adr/0017-single-package.md)).

**Upgrading.** `jigs upgrade` in the factory: it moves the jigs pin to the
latest release (`--to <version>` picks one), runs `jigs up` — its `--force`
and `--no-doctor` pass through — then the factory's own typecheck, which names
any wrapper a release asks `steps/jigs.ts` to grow. A release that moves one
of the four runtime peers — `workflow`, `@workflow/world-postgres`,
`@workflow/web`, `zod` — fails the install by name; make the same move in the
factory's `package.json` and run it again. A factory still carrying the
`@salimhamed/jigs-service` dependency retired in 0.3.0 is refused: drop that
line and rewrite its `@salimhamed/jigs-service/X` imports to
`@salimhamed/jigs/X` first ([ADR 0017](adr/0017-single-package.md)).

pnpm verifies the whole lockfile against its `minimumReleaseAge` policy
before it resolves anything, so a dependency is still age-checked on the very
install that removes it. Leave a recently published package's
`minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` until that install
has run, then drop the entry. Both factories hit this moving off
`@salimhamed/jigs-service`.

**Releasing this repo (once, by whoever owns it).** The package carries
ordinary semver from `0.1.0` on, and nothing here moves it by hand. A PR's
title is a conventional commit — CI rejects one that is not — and merging it
to `main` opens or updates a release-please PR carrying the next version and
the CHANGELOG entries it earned; that PR merges itself once its own checks
pass, the tag and GitHub Release follow, and the same run publishes to GitHub
Packages. The number is a coordinate for `jigs upgrade` and a signal to
you, never an input to a run: no step id carries a jigs version, so a release
never renames a memoization key
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
number is already in use, edit it in `jigs.yml`, `docker-compose.yml` and
`.env` before `jigs up`. The numbers in your own output are the ones to use.

### 1. Scaffold

```sh
mkdir my-factory && cd my-factory && git init
pnpm dlx @salimhamed/jigs init
```

`jigs init` writes the infrastructure — `jigs.yml` (the service and dashboard
ports and, later, the ingress URL), `package.json` with jigs pinned to the
version that scaffolded it, `.npmrc`, `nitro.config.ts`, `docker-compose.yml`,
`.env.example`, and the `tsconfig.json`, `pnpm-workspace.yaml` and
`.gitignore` a factory build needs — and the code
the factory starts from: `jigs.config.ts` (this factory's pipelines, keyed by
the name `jigs run` takes), `pipelines/ship.ts` (a ticket to a merged pull
request), `steps/jigs.ts`, `blocks/jigs.ts`, `blocks/review-loop/` (that
pipeline's review loop, written here rather than shipped),
`prompts/describe-pr.ts`, `jigs.config.test.ts` and a `README.md`. Then it
prints the next steps and runs none of them; `jigs up` (step 3) is what runs them. Every file is written
once: a re-run keeps what is there and adds only what is missing, so nothing
init wrote goes stale under you, and from here on the code is this factory's
own.

`steps/jigs.ts` is the one to know about. It holds this factory's `"use step"`
wrappers around jigs' step implementations and nothing else, so a pipeline
imports its steps from `../steps/jigs.ts`, never from
`@salimhamed/jigs/steps`. `blocks/jigs.ts` beside it holds the jigs blocks
(`reviewTicket`, `haltForHuman`, `pullRequestGate`, …) bound to those
wrappers. (Only the steps are bound by the rule: the scaffolded pipeline
imports `ticketInput`, `claimTicket`, `claude` and `codex` from the package
directly, because none of those carries an id.) Both files are ordinary
committed source: commit them and edit them. The one rule is about names —
each wrapper's name, with the path of the file it is exported from, compiles
to a durable step id (`step//./steps/jigs//provisionWorktree`) that the World memoizes runs
against. Renaming or moving one changes that id, so do it only when `jigs ps`
shows no parked runs; a run whose id moved under it shows up stalled, and the
repair is to cancel it and relaunch. Wrapper bodies, and everything in
`blocks/jigs.ts`, are free to change at any time.

**The loop itself is factory code too.** jigs ships the review loop's pieces
as blocks — `implementUntilCodeReviewApproves`, `answerReview`, `fixCi`,
`commitWork`, `postReviewAnswers`, `describePr`, `attend` — and `jigs init`
scaffolds `blocks/review-loop/`, one decision per file, calling them in order.
The split is where a wrong edit lands: jigs owns what would break (the
builder's session pointer, the resume fallback, the ids the gate cursor needs
back, the cap on implement-and-review rounds, and the code-review call that
is never handed the brief), the factory owns what would merely change (the order,
the CI bound, the merge policy, the escalation prose, the prompts). A team
that wants no self-review round, a merge commit instead of a squash, or a
different gate edits its own blocks — and still gets the jigs blocks
underneath fixed by `jigs upgrade`.

`prompts/describe-pr.ts` is the same split at one block. jigs owns the
mechanics — resume the builder that wrote the change, fall back to a fresh context fed
the diff, parse a `{ title, body }` back — and the factory owns the words and
the policy: the conventions it asks for, and what to do when the answer drifts
out of them. The scaffold repairs a drifting title; a factory whose target
repo gates on the title (a conventional-commit check, say) may prefer to throw
and kill the run rather than open a pull request CI will refuse. How a pull
request introduces itself is the factory's voice, and the title is what the
target repo's own CI and release tooling read.

#### Prompts

The words a block speaks are a parameter too. Every jigs block that talks to an
agent ships a **prompt** beside it — a function from a typed input to the text
the agent is told — and takes it as an optional parameter, defaulting to the
one it ships with. A factory that wants different words writes a function of
the same type and passes it in; the block's mechanics do not change.
`reviewTicket` takes `prompt`, `implementUntilCodeReviewApproves` takes
`implementPrompt` and `codeReviewPrompt`, `answerReview` and `fixCi` take
`resumePrompt` and `freshPrompt`, and `commitWork` takes `prompt`.
(`describePr` is the one with no default: its two prompts are
`prompts/describe-pr.ts`, and the caller always passes them.)

Per call site — a prompt of this factory's own, in `prompts/infra-ticket-review.ts`:

```ts
import type { TicketReviewPrompt } from "@salimhamed/jigs/blocks";

export const infraTicketReview: TicketReviewPrompt = ({ ticket }) => `# Ticket review

You are reviewing a ticket for this team's infrastructure repo, where a change
that is wrong is a change that pages someone. Restate the ticket into a brief;
never re-decide it.

## The ticket

${ticket}

...
`;
```

passed where `pipelines/ship.ts` calls the block:

```ts
import { infraTicketReview } from "../prompts/infra-ticket-review.ts";

const handoff = await reviewTicket({
  claim,
  snapshot,
  prompt: infraTicketReview,
  harness: claude({ model: "opus" }),
  cwd: workspace.path,
});
```

Factory-wide — set it once in the `reviewTicket` binding in `blocks/jigs.ts`,
and every pipeline in the factory gets it:

```ts
export function reviewTicket(options: ReviewTicketInput): Promise<Handoff> {
  return reviewTicketBlock({
    prompt: infraTicketReview,
    ...options,
    agent,
    haltForHuman,
    fetchSnapshot: fetchTicketSnapshot,
  });
}
```

The `prompt` goes before the spread, so a call site that passes its own still
wins. Nothing about this is wired: the input is a plain object, the prompt is a
plain function, and `tsc` is what tells you a field the words need is missing.


The starter `ship` pipeline takes its `binding` and `merge` as inputs with no
default, because the scaffold knows neither: once step 4 has bound a repo, give
`binding` that name as its default and list it under `requires.bindings` in
`jigs.config.ts`, so preflight refuses a run the worktree step would otherwise
fail.

### 2. Tokens

```sh
cp .env.example .env      # then fill in LINEAR_API_KEY / GITHUB_TOKEN
```

`.env` is this factory's environment file: the service loads it when it
starts, `jigs bind` reads `GITHUB_TOKEN` out of it, and `PORT` comes from
`jigs.yml` rather than from here. The `LINEAR_API_KEY` / `GITHUB_TOKEN` slots
are consumed by the suspension blocks (`haltForHuman()` posts Linear
comments, `pullRequestGate()` re-checks PR state), and both are validated on
every trigger: preflight refuses to create a run when a requirement is unmet,
reporting every failure with its repair. `jigs doctor` runs the same checks
without a launch.

`WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and `WORKFLOW_POSTGRES_URL`
come filled in; leave them. The service refuses to start when the URL is
unset: the worktree registry lives in that database, so there is no
registry-less mode. (At `workflow@4.8.4` the filesystem World would not start
from a production bundle anyway: `Invalid version string: "bundled"`.)

Skipping the copy is allowed — `jigs up` copies `.env.example` itself when
there is no `.env` and tells you which slots are empty — but a run cannot be
created until both tokens are in.

### 3. Up

```sh
pnpm install              # once: the factory's own jigs lands in node_modules/.bin
pnpm exec jigs up
```

`jigs up` is the commands a human used to type after `jigs init`, run in
order, each idempotent, each its own line:

```
ok   locate (3ms) — /home/you/my-factory
ok   env (1ms) — copied .env.example to .env
     LINEAR_API_KEY, GITHUB_TOKEN empty in .env — fill them in before a pipeline needs them
ok   install (4.7s)
ok   compose (2.1s)
ok   bootstrap (1.3s)
ok   build (1.9s)
ok   service (12ms)
ok   ready (1.8s)
ok   doctor (0.4s)
my-factory-2286ac2a is up at http://localhost:8990 — dashboard http://localhost:9090
```

- **env** copies `.env.example` to `.env` if there is none and reports the
  credential slots still empty.
- **install** is `pnpm install`, reading `@salimhamed/*` from GitHub Packages
  through your `~/.npmrc`.
- **compose** is `docker compose up -d --wait`: this factory's own Postgres
  World, on the port `jigs init` chose.
- **bootstrap** applies the SDK's migrations and the queue schema to that
  World, with the URL from `.env` handed to it explicitly. Idempotent.
- **build** is `jigs build`: this factory's pipelines compiled into
  `.output/server/index.mjs` with the factory's own nitro and its own copy of
  the SDK — the copy that compiles the step ids has to be the copy that
  registers them.
- **service** starts the service if none is running; if one is, it restarts
  it only when the built bundle differs from the one the process started from
  (`--restart` forces it). A restart over in-flight runs asks first —
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
after every change**: edit a pipeline, `jigs up`, and the rebuild and restart
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
jigs service restart      # or jigs up --restart
```

A binding is a name in `jigs.yml` mapped to a target repo's **remote URL**.
jigs keeps its own bare clone per binding, at
`~/.local/share/jigs/bindings/<factory>/<binding>/repo.git`, and cuts every
agent worktree from it — your own checkout of the repo is not involved at all.
Pipelines name bindings; the runtime provisions worktrees from them.

**The clones are made when the service starts**, not when a run asks for a
worktree, so the first start after a bind pays for them — seconds for a small
repo, up to a minute for a large one, and the service logs a line per binding
as it goes. A binding added while the service is running therefore needs the
restart above before any run can name it; `jigs bind` says so, and
`jigs doctor` reports a binding with no clone yet. (Binding before the first
`jigs up` works too and saves the restart; the order here is only the one a
newcomer meets.)

`jigs bind` also creates the repo's webhook, which needs `GITHUB_TOKEN`. Bind
reads it from this factory's `.env`, and an exported one wins for that one
command — a convenience of bind's, not the factory's rule: the service reads
`.env` alone, so a token that only ever lives in your shell leaves the running
factory without one, and bind notes it. The token is for the webhook, not for the binding.

A factory with an `ingress_url` in its `jigs.yml` (step 5) and no usable token
is half configured — an ingress nothing posts to, a PR gate that never wakes —
so `jigs bind` **fails** there rather than noting a skip, and says the repair.
GitHub rejecting the token fails the same way. Fix the token and run the same
`jigs bind` again: the binding it already recorded stands, and the webhook
registration is create-or-verify, so re-running is how you repair. A factory
with no `ingress_url` receives no webhooks at all and binds without a token.

The binding also declares what its worktrees need before an agent can work in
them — files to copy in, commands to run:

```yaml
bindings:
  forge:
    remote: git@github.com:downstreamimpact/Forge.git
    copy: [.env]
    post_create: [mise exec -- npm ci]
    hook_timeout_minutes: 20
```

**A `copy:` entry is a path relative to the binding's own `bindings/<name>/`
directory in this factory repo, and lands at that same relative path inside the
worktree.** So the file above is `bindings/forge/.env` here and arrives as
`.env` at the worktree root; `config/app.local` there arrives as
`config/app.local`. One directory per binding, mirroring the target repo's
tree, so nothing needs a mapping syntax — an entry that reaches outside it, or
that matches nothing, fails the worktree request by naming the binding and the
entry rather than handing an agent a tree missing its secrets.

All three provisioning keys are optional and hand-edited: `jigs bind` writes
`remote:` and nothing else. `post_create` commands run in the worktree, fail
fast, and share one `hook_timeout_minutes` budget (default 10).

Secrets therefore live in this factory repo, gitignored: put the `.env`-class
files under `bindings/<name>/` and add `bindings/*/.env` to the factory's
`.gitignore` — the directory itself can hold committed non-secret files. They
sit next to the pipelines that need them, on the machine that provisions the
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

Put the URL in this factory's `jigs.yml`:

```yaml
ingress_url: https://<machine>.<tailnet>.ts.net
```

#### GitHub (per target repo)

(Re-)bind each target repo — `jigs bind` creates the repo webhook from
`ingress_url`, verifies it on later binds, and repairs drift. It needs
`GITHUB_TOKEN` (a classic PAT with `admin:repo_hook`) in this factory's `.env`
or exported in the shell, and fails without one. The signing secret is the one
thing here that is not per factory: one file per machine at
`~/.local/share/jigs/github-webhook-secret`, generated on the first bind and
shared by every factory's repo webhooks. The service reads
the same file, or `GITHUB_WEBHOOK_SECRET` from `.env` if set. Each factory owns
the hook at its exact URL; changing its hostname creates a new hook and leaves
the old one for you to delete by hand.

Manual alternative: one org-level webhook (org settings → Webhooks) pointed at
`<ingress_url>/ingress/github`, content type `application/json`, events
`pull_request`, `pull_request_review`, `pull_request_review_comment` and
`check_suite`, secret from that same file — covers every repo without per-repo
binds. Note that it points at one factory: an org-level hook and several
factories do not mix.

#### Linear

Create a webhook in Linear (Settings → API → Webhooks) pointed at
`<ingress_url>/ingress/linear` with resource types `Comment` only. Put its
signing secret in this factory's `.env` as `LINEAR_WEBHOOK_SECRET` and
`jigs service restart`.
`jigs doctor` verifies that this exact webhook exists and is enabled.

#### Missed deliveries

```sh
jigs poke <run>
```

manually wakes a suspended run over the same code path as a webhook delivery.

### 6. Operating runs

```sh
jigs run <pipeline> --input ticket=AGE-123
jigs ps
jigs logs <run>
jigs cancel <run> [--force]
jigs sweep [--force]
```

jigs narrates every pipeline milestone in `jigs logs`. A pipeline body that
needs `console.log` is missing a jigs-side line; file a ticket instead of
adding one to the pipeline.

Factories upgrading past 0.1.4 must pass the injected Linear `identifier` as
the second argument to `claimTicket`, or adopt the `ticket=` input shown above.

Every verb dials the service of the factory you are standing in;
`--service <url>` / `JIGS_SERVICE_URL` overrides that. `--input` values are
read as JSON with the raw string as the fallback, so `askHuman=true` is a
boolean and `AGE-123` is a string; a value the pipeline's `inputs` schema
rejects fails in the CLI, before any run is created.

`<run>` is a run id, a unique id prefix, or the ticket the run claimed — an
ambiguous prefix lists its candidates instead of guessing. A ticket named by
its identifier (`AGE-123`) is resolved against Linear first, since the claim
itself is keyed on the issue's UUID.

`jigs cancel` is the escape hatch when a run holds a resource nobody is coming
back for: cancelling releases every hook it claimed, so the same ticket can be
launched again. A suspended run cancels silently — no process is involved —
while a run still in flight is confirmed first, and `--force` skips that
prompt when there is no terminal to answer it. Cancel never deletes anything:
it names the worktrees the run leaves behind, and `jigs sweep` is how they are
reclaimed.

`jigs sweep` is the only thing that ever removes a leftover worktree — nothing
runs in the background. A run whose PR merged tears its own worktree down (the
pipeline's last line); every other ending leaves the tree on disk, visible in
`jigs ps` as `abandoned`. On a terminal, `jigs sweep` asks per worktree, with
a louder warning for trees holding uncommitted work; without a terminal it
only reports, and `jigs sweep --force` removes everything eligible without
asking — dirty trees included, so it is the flag for cron, not for habit.
Each removed line says what became of the branch: deleted when the default
branch already contains it, kept — with the commit count it holds — when it is
the only copy of unmerged work.

**Recurring runs.** A pipeline can also fire on a schedule this factory
declares beside its pipelines, in `jigs.config.ts`:

```ts
export default {
  pipelines: {
    "weekly-report": { pipeline: weeklyReport, inputs: weeklyReportInputs },
  },
  schedules: {
    "monday-report": {
      pipeline: "weekly-report",
      cron: "0 9 * * 1",
      inputs: { audience: "team" },
    },
  },
} satisfies Factory;
```

Five cron fields, read in the service host's local time — UTC on the host in
this example, which is why the timestamps below carry a `Z`. `jigs up` to pick
the schedule up (the bundle changed, so it rebuilds and restarts); the
service's own log then names what it scheduled:

```
[schedule] monday-report scheduled: 0 9 * * 1 → weekly-report, next 2026-09-07T09:00:00.000Z
```

`jigs ps` then prints a schedule table under the runs, and every run the
schedule fired carries its name in the `TRIGGER` column:

```
RUN                              PIPELINE       STATUS   TRIGGER                  AGE
wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  weekly-report  running  schedule:monday-report   2m

SCHEDULE       PIPELINE       CRON       NEXT                      ACTIVE
monday-report  weekly-report  0 9 * * 1  2026-09-14T09:00:00.000Z  wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM
```

Each fire is an ordinary trigger: the inputs are validated against the
pipeline's schema, preflight runs, and a failure is a line in
`jigs service logs` with no run created. A tick whose last run is still active
is skipped and says so, and a tick missed while the service was down is not
made up — the next occurrence is computed from now. A schedule naming a
pipeline that does not exist, a cron that does not parse, or inputs the schema
rejects is refused at startup with its repair, and `jigs doctor` reports the
same thing on demand.

### 7. Run history (the dashboard)

The service hosts the SDK's observability UI — run history, step attempts,
events — on the port this factory's `jigs.yml` declares beside its service
port:

```yaml
service:
  port: 8990
  dashboard_port: 9090
```

`jigs init` writes both, from ranges that cannot overlap. `dashboard_port` is
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
step//./steps/jigs//provisionWorktree  completed  1        2026-09-04T10:00:00.000Z  1.2s

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
