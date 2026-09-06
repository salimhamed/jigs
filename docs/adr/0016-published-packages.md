# jigs is installed from GitHub Packages, and a factory owns its runtime

jigs ships as two published packages, `@salimhamed/jigs` and
`@salimhamed/jigs-service`, on GitHub Packages under the `@salimhamed` scope,
private like the repo. A factory pins both to one version in its own
`package.json` and runs its own copy of the CLI from `node_modules/.bin`;
nothing is installed globally, nothing is cloned, and no `link:` points at a
checkout. The one command that runs before a factory exists is
`pnpm dlx @salimhamed/jigs init`, which writes files and runs nothing.
`jigs up` takes the files to a running service, and `jigs upgrade` moves both
pins together and runs `up` again. The service stays a host process. Decided
by Salim on 2026-09-06; the measurements below are from the packaging spike
that preceded it, and the code landed across the tsdown build
([ADR 0013](./0013-factory-owned-steps.md)'s amendment), the templates moving
into the CLI, the peer split, and the rename to the scoped names.

Until now a factory installed both packages by `link:` into a checkout of this
repo, and `jigs init` ran from that checkout's build. That was honest while the
API churned daily — `git pull` was the upgrade — but it put a second repo on
every operator's machine, made every factory `package.json` a machine-flavoured
absolute path, and meant a rebuild of the checkout was part of every upgrade
recipe. Publishing was gated on one question: would the step ids survive the
move from a linked source tree to an installed tarball? They do
([ADR 0013](./0013-factory-owned-steps.md) is why), and the spike measured it —
the ids came out identical from a tarball install, and the bundle booted.

## The decision, piece by piece

**GitHub Packages, not npmjs.** The repo is private and so are the packages;
GitHub Packages is the registry the repo already authenticates to, and the
`GITHUB_TOKEN` of the release workflow can publish there with a `packages:
write` grant and nothing else ([ADR 0014](./0014-release-automation.md)). The
scope must equal the repository owner, hence `@salimhamed/…`, and each
`package.json` names the repository so GitHub links the package to it — that
link is what lets the repo-scoped token publish.

**Two packages, the merge deferred.** `@salimhamed/jigs` is the CLI and the
library-first core (harnesses, checks, prompts, the plain step
implementations); `@salimhamed/jigs-service` is the app, its routes, and the
primitives pipelines are written against, and it depends on the first. They
could be one package. They stay two because the split is the current shape,
the release pipeline already publishes both in lockstep, and merging them is a
rename in every factory's imports on the same day as the scoped rename — one
breaking rename at a time.

**No global install.** A factory's `package.json` pins both packages, so the
`jigs` a factory runs is the one it compiled against: `pnpm exec jigs`. A
global CLI would be a third version on the machine, able to `build` a factory
with a `@salimhamed/jigs-service/build` that is not the factory's own. The
only pre-factory command is `pnpm dlx @salimhamed/jigs init`, and the factory
it writes pins both packages to the exact version of the CLI that scaffolded
it — lockstep, so the pair is one number.

**`init` writes files; `up` runs things.** `jigs init` writes the factory's
infrastructure and starting code, once each, and prints the next steps. It
touches nothing on the machine. `jigs up` is the commands a human used to type
afterwards, in order, each idempotent, each its own line, stopping at the
first failure with the repair beside it: copy `.env`, `pnpm install`, `docker
compose up`, bootstrap the World, `jigs build`, start or restart the service
(only when the bundle changed, and asking first over in-flight runs), wait for
`/health`, `jigs doctor`. `jigs upgrade` is `pnpm update` of both pins, then
`up`, then the factory's own typecheck — the only step that can see what a
release asks of the factory's `steps/jigs.ts`.

**The service stays a host process.** A container was considered and set
aside: the service drives the operator's `claude` and `codex` logins, reads
the operator's AWS SSO cache for the `aws` check (`aws sts get-caller-identity`
under the service's `AWS_PROFILE`) and for any MCP server a step spawns with
it, and cuts git worktrees from clones it keeps under the operator's data
directory using the operator's SSH and git credentials. Every one of those is a host fact that
a container would have to be handed back through mounts and env, and the
supervision jigs already has — a pidfile per factory, `jigs service
start|stop|restart|status|logs` ([ADR 0012](./0012-per-factory-service.md)) —
costs nothing more. Only the World is a container.

## What the factory must still install itself, and why

The dependency shape was measured, not designed, by installing both packages
from `pnpm pack` tarballs into a copied factory and booting it. Three facts
came out, and they fix the shape:

1. **Nitro inlines the service into the bundle.** Nitro 3 externalizes only
   native addons; everything else is bundled at build time, resolved from the
   importer's real path. So `croner`, `hono`, `postgres` and `undici` are
   ordinary `dependencies` of `@salimhamed/jigs-service`, satisfied by pnpm's
   sibling symlinks under `.pnpm/`, and a factory lists none of them. The two
   real factories carry `croner`, `hono` and `postgres` today, a leftover of
   the linked-source era; the rollout drops them.
2. **The SDK loads the World and the dashboard by name at run time.** Booting
   the bundle with the service's dependencies alone failed:
   `Cannot find module '@workflow/world-postgres'`. `@workflow/core`'s
   `createWorld` does a `require(targetWorld)` anchored at the bundle, and the
   dashboard plugin does the same for `@workflow/web/server` from the factory
   root. Both resolve from the factory's top-level `node_modules`, where pnpm's
   isolated layout puts nothing transitive. So `@workflow/world-postgres` and
   `@workflow/web` are peers the factory installs itself — and so is
   `workflow`, which the factory imports directly and which must be one copy
   per process (the copy that compiles the step ids has to be the copy that
   registers them).
3. **zod must be one copy, and only the peer shape guarantees it.** A factory
   hands schemas to jigs (an agent step's `output`), so two zod copies are two
   incompatible types. With zod in both packages' `dependencies` as `^4.4.3`
   and the factory pinned to `4.4.3` — what both real factories do — pnpm
   resolved the range to the newest release and installed **two** copies. With
   zod a `peerDependency` of both packages, the same factory pin gave one copy
   everywhere. The peer shape is therefore not a convention; it is the only
   shape under which an exact factory pin is safe.

So the **factory-supplied runtime** is exactly four packages: `workflow`,
`@workflow/world-postgres`, `@workflow/web` and `zod`, listed as
`peerDependencies` of the service (zod of both packages), mirrored in
`devDependencies` for the workspace, and pinned in `jigs init`'s
`package.json` template at the same versions; `package.test.ts` fails if the
three disagree. `nitro` is an optional peer, only so the emitted `.d.ts` keeps
`import { NitroConfig } from "nitro/types"` external instead of inlining
585 kB of types.

**A mismatch has to fail, not warn.** pnpm's default on a peer mismatch is a
warning and a second copy — the silent failure this whole shape exists to
avoid. `strict-peer-dependencies=true` in `.npmrc` had no effect under pnpm 11
(exit 0); `strictPeerDependencies: true` in `pnpm-workspace.yaml` turned the
same mismatch into `ERR_PNPM_PEER_DEP_ISSUES`, exit 1. The template carries
that line, and `jigs upgrade` recognizes the error and names the four
packages to move.

**A published package depending on a published package.** The service tarball
declares `@salimhamed/jigs@<version>` as a dependency, which the registry
resolves — not a `file:` entry beside it. A tarball-based e2e therefore needs a
pnpm `overrides` entry pointing the transitive name at the local tarball, and
a committed lockfile cannot survive a repack (the `file:` integrity changes
with any source change), so the e2e installs into a temp dir with no lockfile.
Neither concerns a factory installing from the registry.

## Consuming and publishing

**The consumer's `~/.npmrc`** carries two lines: `@salimhamed:registry=https://npm.pkg.github.com`
and `//npm.pkg.github.com/:_authToken=<token>`. The token is a **classic** PAT
with `read:packages`, plus `repo` while the repository is private; fine-grained
PATs cannot read GitHub Packages' npm registry today. The scope line is what
routes `pnpm dlx @salimhamed/jigs init` as well as every later install, so one
file serves the whole lifecycle. The scaffolded factory `.npmrc` carries the
scope line only, never a token, and `init`'s test asserts that.

**The publisher is `GITHUB_TOKEN`.** ADR 0014's anti-loop rule forces a PAT
onto release-please because the events it raises must start workflow runs; a
publish raises no event anything waits on, so the rule does not apply, and
`packages: write` on the workflow is the exact grant. A PAT would carry
`write:packages` across every repository its owner can reach, in a secret for
the one job that does not need it. The publish job runs after the Releases
are cut, gated on `releases_created`, skips a version the registry already
holds so a re-run is idempotent, uses `--no-git-checks` because the checkout
is detached at the squash commit, and passes no `--provenance`: npm issues
attestations on the public registry only.

## Consequences

- **A factory `package.json` is portable.** Both jigs pins are versions, not
  paths; the four runtime peers are pinned beside them; `croner`, `hono` and
  `postgres` are gone from it. `strictPeerDependencies: true` sits in
  `pnpm-workspace.yaml`, and `.npmrc` routes the scope. The two existing
  factories need exactly that edit, plus the import rename
  (`@jigs/service` → `@salimhamed/jigs-service`, `jigs` → `@salimhamed/jigs`)
  in `steps/`, `pipelines/`, `jigs.config.ts`, `jigs.config.test.ts` and
  `nitro.config.ts`, and a `~/.npmrc` token on the machine.
- **Every step id is unchanged by the move.** They are factory-local paths
  ([ADR 0013](./0013-factory-owned-steps.md)); the tarball e2e diffs them
  against the recorded list on every PR, and a real factory's own
  `jigs.config.test.ts` does the same after its rollout.
- **Amends ADR 0013's consequences.** "Factories install both by `link:`" is
  no longer true: they install from the registry, and the version is a
  `pnpm update` coordinate as well as a signal. The wrapper file is scaffolded
  once by `init`, and the gap a release opens in it is reported by
  `jigs upgrade`'s final typecheck rather than discovered at run time.
- **The pre-publish `~/.npmrc` shape is the operator's to set.** The
  `GITHUB_PACKAGES_TOKEN` env reference some machines already carry works if
  the variable is exported in the shell that runs pnpm, and silently fails to
  authenticate if it is not; a literal token line does not have that failure
  mode.
- **`jigs upgrade` refuses a `link:` factory.** A factory still wired to a
  checkout gets the two published names added beside the linked ones, and
  compiles against one jigs while running another; `upgrade` checks the
  manifest first and names the switch to make.

## Considered options

- **Public npm.** Rejected for now: the repo is private and the packages
  follow it. Moving later takes a `publishConfig.registry` change (or its
  removal), `access: public`, an `NPM_TOKEN` secret since `GITHUB_TOKEN`
  cannot publish to npmjs, `--provenance` becoming possible, and dropping the
  scope line from every consumer's `~/.npmrc` and the factory `.npmrc`
  template. Nothing in the dependency shape changes.
- **One package.** Deferred, not rejected — see above. The merge is a rename
  of every factory import and should land on its own day.
- **A global `jigs`** (`pnpm add -g`, or a shim on `PATH`). Rejected: a third
  version on the machine, and `jigs build` resolving a service that is not the
  factory's own. `pnpm dlx` gives the one pre-factory command its CLI without
  leaving one installed.
- **`jigs init` also runs the install and the first `up`.** Rejected: `init`'s
  value is that a failure of any later step is one the human can see and
  name; folding them together hides which one failed. `up` keeps that by
  giving every step its own line.
- **Runtime peers as ordinary dependencies of the service**, so a factory
  lists two packages instead of six. Measured and rejected: the World and the
  dashboard are loaded by name from the factory root and are not found, and
  zod ends up as two copies against an exact factory pin.
- **A containerized service.** Rejected for the host facts above. A future
  where the harness CLIs, the SSO cache and the git credentials all live in
  the container is a different product.

## Known costs, accepted with eyes open

- **A token on every machine.** Every operator, and every CI that installs a
  factory, needs a classic PAT with `read:packages`; fine-grained tokens will
  not do until GitHub Packages accepts them. The token expires, and the
  failure is a 404 from `npm.pkg.github.com` rather than a 401 — `jigs
  upgrade` translates it, plain `pnpm install` does not.
- **The scoped rename is breaking for both real factories at once.** It has
  to be sequenced: the first publish lands, then each factory's edit, then a
  restart. Their step ids do not move, but their `package.json`, imports and
  `.npmrc` all do.
- **Four version numbers the factory must track by hand.** A jigs release that
  moves a runtime peer fails the factory's next install by name; the fix is
  the same move in the factory's `package.json`, and `jigs init`'s template
  is where the current numbers are. `strictPeerDependencies` makes it loud;
  nothing makes it automatic.
- **The first publish is unverified until it runs.** Whether `GITHUB_TOKEN`
  with `packages: write` links both packages to the repository on the first
  release is asserted from GitHub's documentation, not measured; a failure
  there leaves a tagged, uninstallable version and is repaired by re-running
  the workflow ([ADR 0014](./0014-release-automation.md)).
