# jigs ships as one package, installed from GitHub Packages

jigs ships as one published package, `@salimhamed/jigs`, on GitHub Packages
under the `@salimhamed` scope, private like the repo. It is the whole of jigs:
the CLI, the blocks a pipeline calls, the step implementations a factory wraps,
the service a factory builds and runs, and the templates `jigs init` writes
from. A factory lists one jigs dependency, pins it to a version in its own
`package.json`, and runs its own copy of the CLI out of `node_modules/.bin`.
Nothing is installed globally, nothing is cloned, and no `link:` points at a
checkout. The one command that runs before a factory exists is
`pnpm dlx @salimhamed/jigs init`.

> **Rewritten on 2026-09-11.** This ADR and the retired ADR 0016 told one
> story in two halves: 0016 decided the registry, the install shape and the
> four packages a factory supplies itself, and deferred the package merge by
> one release; 0017 then made the merge. Everything that survived of 0016 is
> folded in below, and the parts that did not (the two package names, the
> audit of what the split bought, the per-factory migration recipe, the
> subpath list from before 0.5.0) are in git history. The decisions here are
> Salim's, on 2026-09-06.

## How it got here

A factory used to install jigs by `link:` into a checkout of this repo, and
`jigs init` ran from that checkout's build. That was honest while the API
churned daily, because `git pull` was the whole upgrade. It also put a second
repo on every machine, made every factory `package.json` carry a machine
specific absolute path, and made a rebuild of the checkout part of every
upgrade recipe.

Publishing was gated on one question: would the step ids survive the move from
a linked source tree to an installed tarball? They do, because no jigs file
carries a workflow directive and every step id is a factory local path
([ADR 0013](./0013-factory-owned-steps.md)). The packaging spike measured it:
the ids came out identical from a tarball install, and the bundle booted.

jigs then published as two packages for one release, `@salimhamed/jigs` and
`@salimhamed/jigs-service`, and merged them in 0.3.0. The split was never a
boundary in the product. It was a boundary in the build: the service package
shipped raw TypeScript so a factory's own bundler could compile its `"use
step"` files out of `node_modules`. ADR 0013 removed the directives from this
repo entirely, which retired the reason, and what was left was two names for
one library.

## The decision, piece by piece

**GitHub Packages, not npmjs.** The repo is private and so is the package.
GitHub Packages is the registry the repo already authenticates to, and the
release workflow's `GITHUB_TOKEN` can publish there with a `packages: write`
grant and nothing else ([ADR 0014](./0014-release-automation.md)). The scope
has to equal the repository owner, hence `@salimhamed/`, and the
`package.json` names the repository so GitHub links the package to it. That
link is what lets a repo scoped token publish.

**No global install.** A factory's `package.json` pins jigs, so the `jigs` a
factory runs is the one it compiled against: `pnpm exec jigs`. A global CLI
would be a third version on the machine, able to build a factory against a
`@salimhamed/jigs/build` that is not the factory's own. `pnpm dlx` gives the
one pre-factory command its CLI without leaving one installed.

**`init` writes files; `up` runs things.** `jigs init` writes the factory's
infrastructure and its starting code, once each, and prints the next steps. It
touches nothing else on the machine. `jigs up` is the commands a human used to
type afterwards, in order, each idempotent, each on its own line, stopping at
the first failure with the repair beside it. `jigs upgrade` is a `pnpm update`
of the pin, then `up`, then the factory's own typecheck, which is the only
step that can see what a release asks of the factory's `steps/jigs.ts`.

**The service stays a host process.** A container was considered and set
aside. The service drives the operator's `claude` and `codex` logins, reads
the operator's AWS SSO cache for the `aws` check and for any MCP server a step
spawns with it, and cuts git worktrees from clones it keeps under the
operator's data directory using the operator's SSH and git credentials. Every
one of those is a host fact a container would have to be handed back through
mounts and environment variables, and the supervision jigs already has costs
nothing more: a pidfile per factory, and `jigs service
start|stop|restart|status|logs` ([ADR 0012](./0012-per-factory-service.md)).
Only the World is a container.

**The public surface is small and named by kind.** As of 0.5.0 the exports map
is the package root, `./blocks`, `./steps`, and the service paths the build
uses (`./app`, `./nitro`, `./schedules`, `./build`, `./plugins/start-world`,
`./plugins/start-dashboard`). Which names live behind which path, and why the
split is drawn there, is [ADR 0019](./0019-layout-by-code-kind.md).

## What the factory must install itself, and why

The dependency shape was measured, not designed, by installing from `pnpm
pack` tarballs into a copied factory and booting it. Three facts came out, and
they fix the shape.

1. **Nitro inlines the service into the bundle.** Nitro 3 externalizes only
   native addons; everything else is bundled at build time and resolved from
   the importer's real path. So `croner`, `hono`, `postgres` and `undici` are
   ordinary dependencies of jigs, satisfied by pnpm's sibling symlinks, and a
   factory lists none of them.
2. **The SDK loads the World and the dashboard by name at run time.** Booting
   the bundle with jigs' own dependencies alone failed with `Cannot find module
   '@workflow/world-postgres'`. `@workflow/core`'s `createWorld` does a
   `require(targetWorld)` anchored at the bundle, and the dashboard plugin does
   the same for `@workflow/web/server` from the factory root. Both resolve from
   the factory's top level `node_modules`, where pnpm's isolated layout puts
   nothing transitive. So `@workflow/world-postgres` and `@workflow/web` are
   peers the factory installs itself, and so is `workflow`, which the factory
   imports directly and which must be one copy per process: the copy that
   compiles the step ids has to be the copy that registers them.
3. **zod must be one copy, and only the peer shape guarantees it.** A factory
   hands schemas to jigs, such as an agent step's `output`, so two zod copies
   are two incompatible types. With zod in jigs' dependencies as `^4.4.3` and
   the factory pinned to `4.4.3`, pnpm resolved the range to the newest release
   and installed two copies. With zod a peer dependency, the same factory pin
   gave one copy everywhere. The peer shape is therefore not a convention. It
   is the only shape under which an exact factory pin is safe.

So the **factory supplied runtime** is exactly four packages: `workflow`,
`@workflow/world-postgres`, `@workflow/web` and `zod`, declared as
`peerDependencies`, mirrored in `devDependencies` for the workspace, and
pinned at the same versions in `jigs init`'s `package.json` template.
`package.test.ts` fails if the three disagree. `nitro` is an optional peer,
only so the emitted `.d.ts` keeps `import { NitroConfig } from "nitro/types"`
external instead of inlining 585 kB of types.

**A mismatch has to fail, not warn.** pnpm's default on a peer mismatch is a
warning and a second copy, which is the silent failure this whole shape exists
to avoid. `strict-peer-dependencies=true` in `.npmrc` had no effect under pnpm
11 and exited 0; `strictPeerDependencies: true` in `pnpm-workspace.yaml` turned
the same mismatch into `ERR_PNPM_PEER_DEP_ISSUES` and exit 1. The template
carries that line, and `jigs upgrade` recognizes the error and names the four
packages to move.

## Consuming and publishing

**The consumer's `~/.npmrc`** carries two lines:
`@salimhamed:registry=https://npm.pkg.github.com` and
`//npm.pkg.github.com/:_authToken=<token>`. The token is a classic personal
access token with `read:packages`, plus `repo` while the repository is
private; fine grained tokens cannot read GitHub Packages' npm registry today.
The scope line routes `pnpm dlx @salimhamed/jigs init` as well as every later
install, so one file serves the whole lifecycle. The scaffolded factory
`.npmrc` carries the scope line only, never a token, and `init`'s test asserts
that.

**The publisher is `GITHUB_TOKEN`.** ADR 0014's anti-loop rule forces a
personal access token onto release-please, because the events release-please
raises must start workflow runs. A publish raises no event anything waits on,
so the rule does not apply, and `packages: write` on the workflow is the exact
grant. The publish job runs after the Releases are cut, is gated on
`releases_created`, skips a version the registry already holds so a re-run is
idempotent, and uses `--no-git-checks` because the checkout is detached at the
squash commit. It passes no `--provenance`: npm issues attestations on the
public registry only.

## Consequences

- **A factory `package.json` is portable.** The jigs pin is a version, not a
  path. The four runtime peers are pinned beside it,
  `strictPeerDependencies: true` sits in `pnpm-workspace.yaml`, and `.npmrc`
  routes the scope.
- **No step id moves, ever, for a packaging reason.** Step ids are factory
  local paths ([ADR 0013](./0013-factory-owned-steps.md)), so neither the
  registry move nor the package merge could address one. `pnpm e2e` proves it
  on every PR: it scaffolds a factory, builds it twice with the package at two
  versions, and diffs the ids against `e2e/expected-ids.txt`.
- **The dependency direction is a convention now, not a package boundary.**
  Nothing stops a future edit importing `postgres` from a file the CLI
  reaches. What catches it is `e2e/check-step-ids.mjs`, which walks the built
  `dist/cli.js` and fails on any import outside `commander`, `yaml` and `zod`,
  and which also scans the workflow bundle for `node:` specifiers and
  `process.env`. Those fail loudly, but none of them is the package manager,
  and that is a real loss.
- **One of everything else.** One `package.json`, one tsdown config with one
  entry per export subpath plus the bin, one `tsconfig.json`, one vitest
  config and one live config, one biome scope, one release-please component,
  one publish.
- **The retired names are refused, not ignored.** `jigs upgrade` fails against
  a factory that still lists `@salimhamed/jigs-service` and prints the two
  moves to make, because `pnpm update` on a name no release has is a silent
  no-op and the upgraded factory would build imports that resolve to nothing.
  A factory still installing jigs from a checkout is refused the same way.

## Considered options

- **Public npm.** Rejected for now: the repo is private and the package
  follows it. Moving later takes a `publishConfig.registry` change or its
  removal, `access: public`, an `NPM_TOKEN` secret since `GITHUB_TOKEN` cannot
  publish to npmjs, `--provenance` becoming possible, and dropping the scope
  line from every consumer's `~/.npmrc` and from the factory `.npmrc`
  template. Nothing in the dependency shape changes.
- **Keep two packages.** Defensible only with a third consumer of the core
  that is not the service. Nothing in the tree suggested one, and
  release-please's `linked-versions` plugin had already forced the two version
  numbers equal, so the split bought a second CHANGELOG and nothing else.
- **Merge, but put the service's subpaths under a `service/` prefix.**
  Rejected at the time: it doubled the migration, name and path, for a
  distinction the directory layout already made.
- **A global `jigs`.** Rejected: a third version on the machine, and
  `jigs build` resolving a service that is not the factory's own.
- **`jigs init` also runs the install and the first `up`.** Rejected. `init`'s
  value is that a failure of any later step is one a human can see and name;
  folding them together hides which one failed.
- **Runtime peers as ordinary dependencies**, so a factory lists one package
  instead of five. Measured and rejected: the World and the dashboard are
  loaded by name from the factory root and are not found, and zod ends up as
  two copies against an exact factory pin.
- **A containerized service.** Rejected for the host facts above. A future
  where the harness CLIs, the SSO cache and the git credentials all live in
  the container is a different product.

## Known costs, accepted with eyes open

- **A token on every machine.** Every operator, and every CI that installs a
  factory, needs a classic personal access token with `read:packages`. Fine
  grained tokens will not do until GitHub Packages accepts them. The token
  expires, and the failure is a 404 from `npm.pkg.github.com` rather than a
  401. `jigs upgrade` translates it; plain `pnpm install` does not.
- **Four version numbers the factory tracks by hand.** A jigs release that
  moves a runtime peer fails the factory's next install by name, and the fix
  is the same move in the factory's `package.json`. `jigs init`'s template is
  where the current numbers are. `strictPeerDependencies` makes it loud;
  nothing makes it automatic.
