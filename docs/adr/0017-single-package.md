# jigs ships as one package

`@salimhamed/jigs` is the whole of jigs: the CLI, the library-first core, the
Nitro app, the pipeline primitives, the worktree lifecycle, the providers and
the plugins. `@salimhamed/jigs-service` is retired. A factory lists one jigs
dependency, imports every part of it through a subpath of one name, and
upgrades with `jigs upgrade`. Decided by Salim on 2026-09-06, one release after
the scoped publish ([ADR 0016](./0016-published-packages.md)) deferred exactly
this.

The split was never a boundary in the product. It was a boundary in the build:
[ADR 0012](./0012-per-factory-service.md) needed a package whose `"use step"`
files could be compiled by the factory's own bundler from `node_modules`, so
`@jigs/service` shipped as raw TypeScript while the CLI shipped compiled. Both
halves of that reason have since lapsed —
[ADR 0013](./0013-factory-owned-steps.md) moved the wrappers into the factory
so no jigs package carries a directive at all, and ADR 0013's own 2026-09-06
amendment moved the service to a `dist/` build. What was left was two names for
one library.

## What the split still bought, and why none of it survived the audit

The design spike measured the split against what it cost. Five things were
genuinely bought, and each is either cheaper another way or already gone:

1. **A dependency direction the package manager enforced** — service → jigs,
   never back — which kept `dist/cli.js` free of nitro, hono, postgres and the
   SDK. In one package this becomes import discipline plus an assertion. It is
   an assertion now: the CLI's one crossing (`build.ts` resolving
   `@salimhamed/jigs/build` from the factory root) stays a `createRequire`
   call, and `e2e/check-step-ids.mjs` walks the built `dist/cli.js` and fails
   on any import outside `commander`, `yaml` and `zod`.
2. **Peer declarations only on the service.** The peers are unchanged —
   `@workflow/web`, `@workflow/world-postgres`, `workflow` and `zod`, with
   `nitro` optional — and now sit on the one package. A factory already
   installed all four.
3. **Two independent vitest runs.** One config, one include pattern; the live
   tests that need Postgres are still selected by `*.live.test.ts`.
4. **A name that says "server-side".** A subpath says it as well:
   `@salimhamed/jigs/review-loop/loop` reads no worse than
   `@salimhamed/jigs-service/review-loop/loop`.
5. **Separate version numbers.** Nullified from the start by release-please's
   `linked-versions` plugin: the two numbers were forced equal, so the split
   bought a second CHANGELOG and nothing else.

Against that, the split cost three parallel resolution tables for one import
(`tsconfig` `paths`, two vitest `resolve.alias` blocks, and the `exports` map),
a root barrel exporting ~50 CLI-internal symbols across the seam, and four of
the refactor audit's code-move items that exist only because a lifecycle is
split across two packages.

## The shape

> **Amended on 2026-09-06, one release later.** One line of the subpath list
> below has moved. `./review-loop/loop` is gone: jigs no longer exports a
> `reviewLoop`, it exports the review loop's building blocks under
> `./review-loop`, and the composition that calls them in order is scaffolded
> into the factory as `pipelines/review-loop.ts`. `./review-loop/pull-request`
> and every other subpath here are unchanged, and the union rule for `./steps`
> still holds.

**One name, the service's subpaths kept.** Every subpath keeps the name it had:
`./app`, `./nitro`, `./build`, `./schedules`, `./steps/run`, `./steps/jit`,
`./suspension/claim`, `./suspension/needs-human`,
`./suspension/pull-request-gate`, `./ticket/review`, `./ticket/snapshot`,
`./review-loop/loop`, `./review-loop/pull-request`, `./worktrees`,
`./providers/linear`, `./plugins/start-world`, `./plugins/start-dashboard`,
beside the CLI's `./checks`, `./prompts`, `./harnesses` and `./steps/execute`.
A factory's import rename is therefore one substitution on the package name and
nothing else — which is what keeps the migration a `sed`.

> **Amended by [ADR 0018](./0018-building-blocks-not-compositions.md) on
> 2026-09-06.** `./review-loop/loop` leaves this list. The review loop's
> composition moves to the `jigs init` scaffold as factory code, jigs stops
> exporting `reviewLoop`, and what stays in the library is the building blocks
> that composition calls. `./review-loop/pull-request` is unaffected — it is
> step implementations, not composition. Every other subpath above stands, and
> so does the property this section is about: no step id moves, because none of
> them was ever a subpath ([ADR 0013](./0013-factory-owned-steps.md)).

**`./steps` is the union.** The one collision the spike predicted: both
packages exported `./steps`. Checked symbol by symbol, the two sets are
disjoint — the CLI side is `claude`, `codex`, the harness and wire types, the
step-result types; the service side is `agent`, `ask`, `resumeOrRebuild`,
`parseOutput` and their types — so `@salimhamed/jigs/steps` exports the union
under the names both already had, and no factory import needs a second edit.
The service's `steps/index.ts` moved to `steps/builders.ts` (keeping its
history), and the new barrel re-exports it beside the CLI's step modules.

**The root export shrinks to what a consumer names.** `"."` was a 55-symbol
barrel whose only reader was the other package: every CLI command function, the
git helpers, `CliError`, `locateFactoryRoot`, the binding and clone helpers.
Measured by grep across both real factories and the templates, what is actually
imported from either root is `ticketInput`, `type Factory` and
`type WorktreeFacts`. The root is now those, plus the three type names
`Factory`'s own definition reaches (`PipelineEntry`, `AnyPipelineEntry`,
`Schedule`); everything else became a relative import. That is refactor audit
item **C9**, landed as a consequence of the merge rather than as its own PR.

**One of everything else.** One `package.json` (the service's plain
dependencies — `croner`, `hono`, `postgres`, `tinyglobby`, `undici` — are now
plain dependencies of jigs), one tsdown config with one entry per export
subpath plus the bin, one `tsconfig.json` on `nodenext` with the `workflow` TS
plugin the service code needs, one vitest config and one live config, one biome
scope, one release-please component, one publish.

## Consequences

- **Every factory renames its imports, once.** `@salimhamed/jigs-service/X` →
  `@salimhamed/jigs/X`, and the `@salimhamed/jigs-service` line leaves
  `package.json`. `jigs upgrade` refuses to run against a factory that still
  lists the retired name and prints exactly those two moves, because `pnpm
  update` on a name no release has is a silent no-op and the "upgraded" factory
  would build imports that resolve to nothing.
- **No step id moves.** They are factory-local paths
  ([ADR 0013](./0013-factory-owned-steps.md)), so a package merge cannot
  address one. `pnpm e2e` proves it the same way it always has: it scaffolds a
  factory, builds it twice with the package at two versions, and diffs 17 ids
  against `e2e/expected-ids.txt`. The list is unchanged by this ADR.
- **The release is a major.** Version `0.3.0` under
  `bump-minor-pre-major`; the breaking change is the import rename, and no
  factory can install by version until it lands.
- **Amends [ADR 0016](./0016-published-packages.md)'s "two packages, the merge
  deferred".** The reason given there was one breaking rename at a time; the
  scoped rename shipped in 0.2.0, so the second one can go now.
- **The `link:`-era arguments are all spent.** ADR 0012's raw-TypeScript
  library, ADR 0013's "the version is only a signal", ADR 0014's lockstep
  paragraph and its near-empty synchronization entries: each was a fact about
  two packages, and each has an amendment block pointing here.
- **The dependency direction is now a convention.** Nothing stops a future
  edit importing `postgres` from a file the CLI reaches. What catches it is the
  e2e's walk of `dist/cli.js`, its zero-`node:`-builtins assertion on the
  workflow bundle, and the packaging test's no-directives rule — all of which
  fail loudly — but none of them is the package manager, and that is a real
  loss.

## Considered options

- **Keep two packages.** Defensible only with a third consumer of the core that
  is not the service; nothing in the tree or the audit suggests one, and the
  release pipeline had already collapsed the versions into one number.
- **Merge, but rename the service's subpaths under a `service/` prefix**
  (`@salimhamed/jigs/service/nitro`). Rejected: it doubles the migration —
  every factory import would change twice over, name and path — for a
  distinction the directory layout already makes.
- **Rename the CLI-side `./steps` instead of merging the two.** Unnecessary:
  the two symbol sets are disjoint, so the union is a strictly smaller change
  than any rename, and a factory that imports from both today keeps both
  imports working.
- **Keep a root barrel of the old ~50 symbols for compatibility.** Rejected:
  nothing outside this repo ever imported them, and keeping them is keeping the
  seam the merge exists to remove.

## Migration, per factory

One chore PR each, then an upgrade:

```sh
rg -l '@salimhamed/jigs-service' | xargs sed -i 's#@salimhamed/jigs-service#@salimhamed/jigs#g'
# drop the "@salimhamed/jigs-service" line from package.json
pnpm exec jigs upgrade --to 0.3.0
```

The typecheck at the end of `jigs upgrade` is what catches a missed import.
Merge the jigs PR first, let the release publish `0.3.0`, then take the
factories one at a time — a factory pinned to `0.2.0` keeps working untouched
until it is moved.
