# Contributing to jigs

## Licensing of contributions

By opening a pull request, you confirm you have the right to submit your contribution, you keep the copyright, and you allow Salim Hamed to license it under any terms, including commercial licenses. This lets me offer commercial licenses to support Jigs; every version still becomes Apache 2.0 after four years.

## Commands

Requires Node 24 or newer, pnpm and Docker. Run every command from the repo
root; each delegates to the packages that have the script.

```sh
pnpm install
pnpm dev           # run the CLI from source
pnpm check         # lint, typecheck, tests (including documentation examples), build, doc comments
pnpm e2e           # bare and linear-ticket-to-pr factories from packed installs; diffs durable IDs
pnpm test:db       # tests that need only Postgres
pnpm test:live     # tests that need real agents or provider credentials
pnpm docs:site     # build the website into docs-site/ (fails on dead links)
pnpm docs:preview  # serve the built site; open the printed /jigs/ URL
pnpm docs:examples # type-check displayed TypeScript examples in isolation
```

With `WORKFLOW_POSTGRES_URL` set, `pnpm e2e` also boots the linear-ticket-to-pr
factory's service, waits for readiness and requires a clean exit on SIGTERM. Put
local values in `.env.e2e.local` (copy `.env.e2e.example`; it is gitignored).
Shell and CI values win over the file. Point it at a dedicated database and port,
never a live factory World.

Before a Workflow SDK or Postgres World upgrade, or a change to service startup
or step transport, run the long-step regression once with the real value:
`JIGS_E2E_LONG_STEP_MS=301000 pnpm e2e` against disposable Postgres, or dispatch
the **Long step regression** workflow in Actions with the revision to test. It
takes over five minutes and never runs on pull requests.

Biome formats at 100 columns.

## Tests

Each package runs its own tests from its own Vitest config. `packages/jigs`
splits its tests into three projects in `packages/jigs/vitest.config.ts`, each
named for what its tests need:

| Project | Files | Needs |
| --- | --- | --- |
| `unit` | `*.test.ts` | Nothing. `pnpm test` and `pnpm check` run it. |
| `db` | `*.db.test.ts` | Postgres. CI runs every one. |
| `live` | `*.live.test.ts` | A logged-in agent CLI or provider credentials. Never in CI. |

A `db` test creates and drops its own databases on the server at
`WORKFLOW_POSTGRES_URL`, or on the container from
`docker compose up -d --wait` (the root `compose.yaml`) when that is unset.
Take the URL and `dbTest` from `packages/jigs/src/db-test-fixtures.ts`: with no URL set and
no container listening, `dbTest` skips; with a URL set, an unreachable server
fails. Each `live` file names the login or credentials it needs. Both
projects read `.env.e2e.local` and run their files one at a time.

`packages/hub` has the same `unit` and `db` projects, with its own `dbTest` in
`packages/hub/src/db/test-database.ts`. Its `test:db` builds the hub first,
because its server test starts the built hub.

## Layout

A pnpm workspace. Every package shares the version release-please cuts;
`@jigs-ai/jigs` and `@jigs-ai/hub` publish.

```
packages/
  jigs/          @jigs-ai/jigs: the library, CLI and service (published)
  hub/           @jigs-ai/hub: the hub server (published)
  hub-protocol/  @jigs-ai/hub-protocol: hub messages, bundled into jigs (private)
tools/api-docs/  TypeDoc and VitePress tooling for site/
site/            the website
skills/          the jigs agent skill
compose.yaml     the Postgres the db tests use
```

The root `package.json` is private and holds shared tooling (Biome) and the
scripts above. `biome.json` and `tsconfig.base.json` are the shared bases each
package's own `biome.json` and `tsconfig.json` extend. Each package has an
`AGENTS.md` with the rules for working in it.

In `packages/jigs`, `src/` is the library and CLI, `templates/` the bare
factory `jigs init` writes, `factory/` the step wrappers and bound routines the
build copies into a factory's `.jigs/`, `recipes/` the workflows `jigs recipe add` copies
into a factory, `migrations/` the jigs tables and `e2e/` the packed-install
check. The npm README and LICENSE are the root copies, which `prepack` copies
in.

```
src/
  workflow/   code that runs inside the workflow bundle: replay-safe, no Node
              built-ins, env or network
  steps/      code that runs in steps, called by factory "use step" wrappers
              (both split by topic: agents, git, human, linear,
               pagerduty, pull-requests, runtime, workspaces)
  service/    the long-running process: routes, hub client, schedules, release
  cli/        commands
  build/      the scaffold templates and the files the build writes into a
              factory's .jigs/, shared by the CLI and the service build
  checks/     preflight, doctor and just-in-time checks
  providers/  Git and provider clients (GitHub, Linear, Slack, PagerDuty)
              with their checks
  config/     factory config, root, env and paths
```

`packages/jigs/.dependency-cruiser.cjs` enforces these boundaries; `pnpm lint` runs it.

`packages/jigs/src/steps/agents/` has one folder per harness, `claude/`, `codex/` and `pi/`,
each holding that harness's driver, process launcher, checks, home handling,
fixtures and tests. `models/` holds the model-source drivers (OpenRouter,
OpenAI-compatible). `shared/` holds what every harness uses: the driver
registry and types, the environment builder, process groups, executables,
skills and MCP credentials, the agent runner and the execute functions.

Tests sit beside the module they test. A test that needs a real login, network
or service ends in `.live.test.ts` and runs only under `pnpm test:live`; every
other test runs offline in `pnpm test`.

The Workflow SDK replays a workflow from its first line on every wake, and
bundles it into a sandbox without Node built-ins. So anything a workflow
imports (`workflow/`) must be side-effect free, and real work goes in steps. No
file under `src/` carries `"use workflow"` or `"use step"`: a step's durable ID
comes from its file path and function name, so the directives live in factory
code and `packages/jigs/factory/steps.ts`, which the build copies into the factory's `.jigs/`,
and a jigs upgrade never renames a step.

Factory code imports the library from the root `@jigs-ai/jigs`. `factory/steps.ts` imports
`@jigs-ai/jigs/steps/<topic>`, and `factory/routines.ts` is the only importer of
`@jigs-ai/jigs/routines`, where the
routines that take steps as arguments live. The other subpaths (`/nitro`,
`/build`, `/service`) belong to the service a factory builds. The Workflow SDK, its Postgres World, the
dashboard and zod are peer dependencies the factory installs. All but zod are
optional peers, so `pnpm dlx @jigs-ai/jigs init` installs none of them or the
native builds they bring; the CLI must never import them.

## Releases

PR titles are conventional commits, checked by CI. Merging to `main` opens or
updates a release-please PR; it auto-merges once its checks pass, then the tag,
GitHub release and npm publish follow. release-please bumps the root
`package.json` and, through `extra-files`, every `packages/*/package.json`, so
all share one version and one `jigs-vX` tag. The publish job builds and
publishes `packages/hub`, then `packages/jigs`, generating the Markdown API
reference in `packages/jigs/docs/api/` from the tag; it ships in the package
and is never committed. The hub goes first so a failed hub publish never
leaves a jigs release without its matching hub; re-running finishes both.

Repository settings the release depends on:

- **Allow auto-merge**, and **Default to PR title for squash merge commits**
  (without it no merge is releasable and no release PR appears).
- A ruleset on `main` requiring `ci`, `step-ids` and `pr-title`.
- A `RELEASE_PLEASE_TOKEN` secret: a fine-grained PAT on this repo with
  Contents, Pull requests and Issues read and write. `GITHUB_TOKEN` would not
  trigger checks on the release PR.
- An npm trusted publisher for each of `@jigs-ai/jigs` and `@jigs-ai/hub`:
  repository `salimhamed/jigs`, workflow `release.yml`, no environment.
  Publishing uses OIDC, no npm token. The hub's first publish and its trusted
  publisher are set up by the maintainer by hand (see Hub previews).

What is easy to break:

- **The squash message must be the PR title alone.** release-please drops a
  commit whose body fails to parse, so a PR-body squash message can silently
  lose a release. Below 1.0.0, `feat:` and `fix:` are patches, `feat!:` is a
  minor, and anything else releases nothing. The title check re-runs on
  `edited`, so fixing a title needs no push.
- **A new package needs an `extra-files` entry** in
  `release-please-config.json`, or its version drifts from the tag.
- **`group-pull-request-title-pattern` is load-bearing.** release-please parses
  its own merged release PR with the same string; changing it breaks the next
  release.
- **Renaming a required job means updating the ruleset.** The PAT also expires;
  a token that can open but not merge leaves the release PR open, which looks
  like no release.
- **Publish is idempotent.** It checks out the tag, refuses a version that does
  not match it, and skips a version npm already holds, so re-running the
  workflow repairs a failed publish. `repository.url` in each published
  `package.json` must name this repository exactly, or trusted publishing
  refuses.
- Automatic releases are safe only because step ids are factory-local paths: a
  version bump never renames a factory's durable addresses.

### Hub previews

The `preview` job in `release.yml` publishes `@jigs-ai/jigs` and `@jigs-ai/hub`
from the `hub` branch. Run it with `gh workflow run release.yml --ref hub`; any
other ref fails. (The Actions UI shows **Run workflow** only once `main`'s
`release.yml` has `workflow_dispatch`.) Both packages get `X.(Y+1).0-hub.N`,
where `X.Y.Z` is the version on the branch and `N` is one past the highest
preview of either package for that minor, under the npm dist-tag `hub`, so
`latest` never moves. Every run publishes a fresh pair; a run that fails
halfway just skips a number. The version lives only in the job's checkout.

Install a preview by its exact version, as pnpm will not resolve a release
younger than a day otherwise: `pnpm dlx @jigs-ai/jigs@0.103.0-hub.0`, and
`npx @jigs-ai/hub@0.103.0-hub.0` with the hub's environment set (see
`packages/hub/AGENTS.md`). `npm view @jigs-ai/jigs dist-tags` shows the latest
preview.

The hub publishes before jigs, so it must be publishable first: its first
publish is by hand with an npm token, then add an npm trusted publisher for
`@jigs-ai/hub` with the same repository and `release.yml` workflow as jigs.
npm points `latest` at a package's first version whatever `--tag` says, so the
hub's `latest` is that hand-published version until the next release, which
moves it like jigs's.

## Website

Guides live in `site/guide/`; `site/api/` is generated by TypeDoc. The Pages
workflow builds the latest stable release tag after a release is published, so
unreleased changes on `main` never reach the site. Each deploy replaces the
whole site. To rebuild by hand, run the Pages workflow on `main` from Actions.
Pages' source is **GitHub Actions**; the `github-pages` environment allows
`main` and `jigs-v*` tags.

TypeScript fences in the website, READMEs, skills, templates and source
`@example` comments are checked directly by `pnpm test` and `pnpm docs:examples`. Show every import and
every variable's source; the checker supplies no missing declarations. Give
cooperating files a first-line comment such as `// workflows/my-flow/steps.ts`.
Relative imports can then resolve another displayed file on the same page.
Examples can also import the actual `#jigs` modules and recipe files.

For configuration excerpts, label the fence `ts factory-options` and explain
that its properties belong inside `defineFactory({ ... })` in `jigs.config.ts`.
The checker wraps only these fragments in an object checked against
`Partial<FactoryDefinition>`; it adds no imports or variables to their scope.

## ADRs

`docs/adr/` records decisions a maintainer reading only the code could undo by
mistake. Keep each to the decision and its consequences, under about 60 lines.
