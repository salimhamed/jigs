# Setting up jigs

Two parts, and the split is the point: the machine is set up once, and then
every factory repo is set up the same way, on its own ports, against its own
World. Nothing below is global except part 1.

## Part 1 — the machine (once)

- **Node >= 24** and **pnpm**. If node comes from a version manager, make sure
  the shell that runs `jigs service start` has it on `PATH` — the service is
  spawned with the CLI's own node.
- **docker**, with the daemon running. Each factory brings up its own Postgres
  container; nothing is shared between them.
- **The jigs CLI on `PATH`.** From a checkout of this repo:

  ```sh
  pnpm install
  pnpm build
  ```

  then link `packages/jigs/dist/cli.js` as `jigs` however you prefer. A
  factory repo installs `jigs` as a dependency too, so `pnpm exec jigs` inside
  one always works without this.
- **The agent harness CLIs** a factory's agent steps drive: the Claude Code
  CLI (`claude` on `PATH`, or `JIGS_CLAUDE_EXECUTABLE` in a factory's `.env`)
  and `codex`, each logged in to its subscription — `claude auth login`,
  `codex login`. `jigs doctor` probes both; a trigger's preflight probes the
  ones its pipeline declares in `requires.harnesses`, and refuses the run when
  one is missing or logged out.
- **A tunnel tool**, if any factory will receive provider webhooks:
  `tailscale` (funnel) or `cloudflared`. Installed once, run per factory.
- **`loginctl enable-linger "$USER"`** for lights-on: services started by
  `jigs service start` are detached from the terminal, but a user session
  manager still reaps them at logout without lingering.

There is no systemd unit and no `~/.config/jigs/service.env`. Both assumed a
single global service; supervision is now a pidfile per factory under the jigs
data dir, and the environment is the factory's own `.env`. A unit per factory
would mean the CLI generating, installing and naming units, and every repair
instruction growing a "which one" — `jigs service restart` is the whole
answer instead.

**Upgrading.** A factory installs `jigs` and `@jigs/service` with `link:`,
pointed at your checkout of this repo, so the upgrade is `git pull` here — no
version range to move in any factory's `package.json`. Two things do not
follow on their own: `pnpm build` again in this checkout — `link:` builds
nothing, so every factory's `jigs` binary and `jigs` type imports are whatever
it last emitted — and each factory's own `steps/jigs.ts`, which you extend by
hand with a wrapper for any step jigs has grown since, and with anything a
jig's deps object has grown that is yours to write rather than to wrap (part 2,
step 1). Typecheck the factory after a pull: the deps objects are typed, so
both kinds of gap are a compile error rather than a surprise at run time.

Both packages carry ordinary semver from `0.1.0` on, and nothing here moves it
by hand. A PR's title is a conventional commit — CI rejects one that is not —
and merging it to `main` opens or updates a release-please PR carrying the next
version and the CHANGELOG entries it earned; that PR merges itself once its own
checks pass, and the tags and GitHub Releases follow. `jigs` and `@jigs/service`
release in lockstep, so both always read the same number. The number is still a
signal to you rather than an input to anything: no step id carries a jigs
version, so a release never renames a memoization key
([ADR 0013](adr/0013-factory-owned-steps.md)), which is what makes automating
it safe ([ADR 0014](adr/0014-release-automation.md)).

**Releasing this repo (once, by whoever owns it).** Two prerequisites live in
GitHub's console rather than in the tree, and the release workflow is inert
without either:

- **A `RELEASE_PLEASE_TOKEN` repository secret.** A fine-grained PAT on this
  repo with **Contents: read and write** (the tags, the CHANGELOGs, the
  version bumps), **Pull requests: read and write** (open and merge the
  release PR) and **Issues: read and write** (release-please manages its own
  labels). It is a PAT rather than `GITHUB_TOKEN` because GitHub raises no
  workflow run for an event `GITHUB_TOKEN` caused: the release PR would get no
  checks to watch, and its squash would never re-run the release
  ([ADR 0014](adr/0014-release-automation.md)).
- **Settings → General → "Default to PR title for squash merge commits".**
  Without it a squash's subject is the branch name, every merge parses as a
  non-releasable unit, and the release PR simply never appears — with no error
  anywhere.

## Part 2 — a factory (per repo)

Every step below runs **inside the factory repo**. Ports are derived from the
factory's path, so two factories on one machine never collide; the numbers in
your own output are the ones to use.

### 1. Scaffold

```sh
mkdir my-factory && cd my-factory && git init
jigs init
```

`jigs init` writes infrastructure only: `jigs.yml` (the service port and,
later, the ingress URL), `package.json`, `nitro.config.ts`,
`docker-compose.yml`, `.env.example`, and the `tsconfig.json`,
`pnpm-workspace.yaml` and `.gitignore` a factory build needs — then prints the
commands below with this factory's ports filled in. It runs none of them:
every one can fail in a way only a human should see.

The code is yours to write: `jigs.config.ts` (this factory's pipelines, keyed
by the name `jigs run` takes), the pipelines themselves, and `steps/jigs.ts`.
The factory repo owns that boilerplate until the API stabilizes — jigs
scaffolds none of it, so nothing it writes goes stale under you.
`e2e/fixture-factory` in the jigs checkout is a worked example to copy from.

`steps/jigs.ts` is the one to know about. It holds this factory's `"use step"`
wrappers around jigs' step implementations, plus the jigs (`reviewLoop`,
`ticketReview`, `needsHuman`, …) wired on top of them — so a pipeline imports
its steps from `../steps/jigs.ts`, never from `@jigs/service` directly. It is
ordinary committed source: commit it, edit it, and **do not rename it or its
exported functions**. Each name compiles to a durable step id
(`step//./steps/jigs//worktree`) that the World memoizes runs against, so a
rename orphans every run this factory has parked — with a clean build and no
error.

Not everything in that file wraps something jigs ships. `reviewLoop`'s deps
require a **`describePr`** the factory writes outright: given the handoff, the
worktree path, the branch point and the builder's session, it returns the
`{ title, body }` the pull request opens with. jigs has no implementation to
wrap here on purpose — how a pull request introduces itself is the factory's
voice, and the title is what the target repo's own CI and release tooling read
(the fixture's is a plain deterministic string; a real factory can ask its
agent). It is a required member, so a factory cannot quietly end up without
one.

### 2. Install, World, bootstrap

```sh
cp .env.example .env      # then fill in LINEAR_API_KEY / GITHUB_TOKEN
pnpm install
docker compose up -d --wait
# bootstrap does not read .env, so pass the World URL explicitly:
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:<postgresPort>/jigs \
  pnpm exec bootstrap
```

`bootstrap` is idempotent — re-run it freely (it applies the SDK's migrations
and the graphile-worker schema).

`.env` is this factory's environment file: `jigs service start` loads it into
the service process, and `PORT` comes from `jigs.yml` rather than from here.
The `LINEAR_API_KEY` / `GITHUB_TOKEN` slots are consumed by the suspension
primitives (`needsHuman()` posts Linear comments, `pullRequestGate()`
re-checks PR state), and both are validated on every trigger: preflight
refuses to create a run when a requirement is unmet, reporting every failure
with its repair. `jigs doctor` runs the same checks without a launch.

The service must run against the Postgres World
(`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, as `.env.example` sets): at
`workflow@4.8.4` the filesystem World fails to start from a production bundle
(`Invalid version string: "bundled"`).

### 3. Build and start

```sh
jigs build
jigs service start
jigs service status
```

`jigs build` compiles this factory's pipelines into `.output/server/index.mjs`
using the factory's own nitro and its own copy of the SDK — the copy that
compiles the step ids has to be the copy that registers them. `jigs service
start|stop|restart|status|logs` supervises that build; `logs` prints the
service's own stdout, which is not the same thing as a run's history (step 6).

Rebuild after every pipeline change. `jigs build` warns when a run is still in
flight: a pipeline that changed shape no longer answers to the step ids its
parked run was memoized under.

#### Step timeout

A step runs **for as long as it takes**. The service prints the ceiling it
started with:

```
[service] step ceiling: no limit on the step route at http://localhost:8990; undici defaults elsewhere
```

Worth knowing about rather than a formality: the World runs every step over
HTTP against the service's own port and re-queues one whose dispatch it loses,
and node's own five-minute default was cutting long agent steps off and
launching a second agent into a worktree the first was still working in
(AGE-360). The service answers that by scoping a no-timeout HTTP dispatcher to
its own origin — so the step self-invocation waits, and every other request it
makes (GitHub, Linear, the agent providers) keeps node's defaults and still
fails against a wedged server.

Cap it in this factory's `jigs.yml` only if you would rather a hung step fail
than hang:

```yaml
service:
  step_timeout_minutes: 90
```

`jigs service restart` applies it. Either way a worktree admits one agent at a
time: a second one is refused, not queued.

### 4. Bind target repos

```sh
GITHUB_TOKEN=… jigs bind ../some-target-repo
jigs bindings
```

A binding is a name in `jigs.yml` mapped to a checkout, pinned to its expected
remote. Pipelines name bindings; the runtime provisions worktrees from them.

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

(Re-)bind each target repo with `GITHUB_TOKEN` set — `jigs bind` creates the
repo webhook from `ingress_url`, verifies it on later binds, and repairs
drift. The signing secret is the one thing here that is not per factory: one
file per machine at `~/.local/share/jigs/github-webhook-secret`, generated on
the first bind and shared by every factory's repo webhooks. The service reads
the same file, or `GITHUB_WEBHOOK_SECRET` from `.env` if set.

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

Factories upgrading past 0.1.4 must pass the injected Linear `identifier` as
the second argument to `claimTicket`, or adopt the `ticket=` input shown above.

Every verb dials the service of the factory you are standing in;
`--service <url>` / `JIGS_SERVICE_URL` overrides that. `--input` values are
read as JSON with the raw string as the fallback, so `askHuman=true` is a
boolean and `AGE-123` is a string; a value the pipeline's `inputs` schema
rejects fails in the CLI, before any run is created.

`<run>` is a run id, a unique id prefix, or the ticket the run claimed — an
ambiguous prefix lists its candidates instead of guessing.

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

### 7. Run history (`workflow web`)

`jigs run` and `jigs logs` hand the log surface back to the SDK, printing

```sh
npx workflow web --backend @workflow/world-postgres <run>
```

The backend is named by the service, not the CLI — `workflow web` otherwise
inspects the local world and finds nothing. Run it from inside the factory,
with that factory's World URL in your shell:

```sh
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:<postgresPort>/jigs \
  pnpm exec workflow web --backend @workflow/world-postgres
```

Serves the SDK's observability UI (default `http://localhost:3456`) reading
the World this factory's service writes — run history, step attempts, events.
It is one UI per World, so run it in the factory whose runs you want.
