# Factory-owned step wrappers, and real versions for every jigs package

The fifteen `"use step"` wrappers live in the **factory repo**, in its own
committed `steps/jigs.ts`. `@jigs/service` exports plain implementation
functions and carries no workflow directive at all, so every jigs step id is a
factory-local address — `step//./steps/jigs//worktree` — with no package name
and no version anywhere in it. That is what lets the jigs packages finally
carry real versions: `jigs` and `@jigs/service` are both `0.1.0` and take
ordinary semver from here on, and the `"version": "0.0.0"` pin
[ADR 0012](./0012-per-factory-service.md) accepted with eyes open is gone.
Delivered across [#30](https://github.com/salimhamed/jigs/pull/30) and
[#31](https://github.com/salimhamed/jigs/pull/31), with the pin removed here.

> **Amended by [ADR 0017](./0017-single-package.md) on 2026-09-06.** There is
> one jigs package now, `@salimhamed/jigs`; read `@jigs/service` below as its
> `/steps/run`, `/suspension/*`, `/ticket/*`, `/review-loop/*` and
> `/worktrees` subpaths, all of which 0.5.0 folded into `./blocks` and
> `./steps` ([ADR 0019](./0019-layout-by-code-kind.md)). This ADR's property is what made that merge safe: no
> jigs package carries a directive, so no step id carries a package name or
> version and a package rename cannot address one. `pnpm e2e` still proves it,
> now by versioning the one package.
This takes the option ADR 0012 rejected — declaring the directives in the
factory rather than in the package — and that ADR's amendments record why the
trade was re-taken.

**A step id is an address, and the SDK picks the addressing scheme from where
the file sits.** `resolveModuleSpecifier` in `@workflow/builders` has exactly
two answers: a file under `node_modules` — or inside a workspace package the
build root depends on — is addressed `name/subpath@version`, and every other
file is addressed by its path relative to the build root. Both are correct for
what they address. An installed file has no stable path to be named by
(`node_modules/.pnpm/@jigs+service@…/node_modules/@jigs/service/src/steps/run.ts`
is a fact about one package manager on one day), so name, subpath and version
are the only durable handle it has. A factory's own file has a path the
factory controls, which is a better name than any of them.

The cost only lands because these ids are memoization keys. A library whose
steps are addressed by version cannot be versioned: a bump renames every key
at once, and every run parked mid-flight replays against ids that no longer
exist — no error, a clean build, just runs that have lost their memory. Moving
the wrappers across the `node_modules` boundary changes which addressing scheme
applies to them, and that is the whole trick. The e2e guard proves it the only
way it can be proved: it builds `e2e/fixture-factory` twice, once with
`@jigs/service` rewritten to a fake version, and diffs the two id sets against
each other and against the checked-in list.

**`@jigs/service` still ships as raw TypeScript, and that is now a choice
rather than a constraint.** ADR 0012 required it — directives do not survive a
compile, and a stripped directive is silent — and with no directives left, the
requirement lapsed. The replacement was measured, not assumed: building the
package to `dist/` with tsdown, repointing every `exports` entry at the
emitted `.js`, and patching `src/nitro.ts`'s plugin path — the first thing
`dist/` breaks — then rebuilding the fixture produced the same eighteen ids
and the same zero `node:` specifiers in the workflow bundle. It stays source
anyway, for a reason that has nothing to do with directives: a factory installs
this package with `link:`, and `link:` builds nothing, so a `dist/` would be
whatever the jigs checkout last happened to emit — `git pull` would stop being
the whole upgrade. `src/nitro.ts` is that in miniature: it hands Nitro an
absolute path into this package (`../plugins/start-world.ts`), which under
`dist/` becomes a path into the bundler's output layout. If jigs ever
publishes, the trade is worth re-taking, and the experiment above is recorded
so it does not have to be re-run.

> **Amended 2026-09-06.** jigs is about to publish, so the trade was re-taken:
> `@jigs/service` now builds to `dist/` with tsdown — one entry per `exports`
> subpath, every entry repointed at the emitted `.js` and `.d.ts`, and
> `"files": ["dist"]` — and the four `jigs` subpaths that still pointed at
> `src/*.ts` (`./checks`, `./prompts`, `./steps`, `./steps/execute`) followed.
> The plugin-path problem above was solved by moving `plugins/` to
> `src/plugins/`, so the plugins sit beside `nitro.ts` in both layouts and it
> derives their extension from its own URL. A published package is dist by
> definition, and the `link:` cost this paragraph named is real but temporary:
> until the factories install from the registry, `git pull` in the jigs
> checkout must be followed by `pnpm build`, the same step the CLI already
> needed. The fixture rebuild produced the same eighteen ids and the same zero
> `node:` specifiers, and the service's own `package.test.ts` now checks every
> exports target against the tsdown entry list instead of asserting `.ts`.

## Consequences

- **The factory's `steps/jigs.ts` path and its exported function names are
  permanent names.** Each one *is* half a durable step id, exactly as the
  filenames in `pipelines/` are. Renaming the file, moving it, or renaming an
  exported wrapper orphans every run that factory has parked, and the build
  stays green while it happens. The file's own header comment says so, and
  `docs/setup.md` says it again at the point a reader first sees the file.
- **The wrappers are committed source the factory maintains by hand.**
  `jigs init` no longer writes or amends the file at all — the boilerplate
  churned faster than the library while the API settles, so it lives in the
  operator's factory repo, with `e2e/fixture-factory/steps/jigs.ts` as the
  worked example (amended from the original offer-to-append design).

  > **Amended 2026-09-06.** The boilerplate settled: two factories and the
  > fixture carried a byte-identical `steps/jigs.ts` for weeks, which is the
  > signal to promote. `jigs init` now scaffolds the file — with
  > `steps/describe-pr.ts`, `jigs.config.ts`, a starter `pipelines/ship.ts`
  > and the ids test — from `packages/jigs/templates/`, and **writes it once**:
  > a file that exists is kept, never rewritten, so from the first commit on
  > the factory owns it and extends it by hand exactly as before. The
  > constraint above is untouched; the file only starts life from the
  > scaffold. The fixture factory is gone: `pnpm e2e` runs `jigs init` into a
  > temp dir outside the repo and builds *that*, so the template every factory
  > starts from is the thing whose ids are diffed against
  > `e2e/expected-ids.txt`, and the scaffolded ids test runs against the same
  > build. The fifteen step ids are unchanged; the fixture pipeline's two ids
  > were replaced by the starter pipeline's one.
- **The exports map is an ordinary export map again.** A subpath was half an id
  while the directives lived here, so a wildcard entry — which the SDK cannot
  match by exact string — collapsed two modules into one namespace, and a
  missing entry was a module no factory could reach. Neither is an id bug any
  more, and the note in `src/package.test.ts` about arming the compiler's
  discovery gate goes too: this package carries no workflow directive, so the
  gate has nothing to decide about it.
- **A version bump is now an ordinary release chore.** Nothing reads either
  package's version at runtime and factories install both by `link:`, so the
  number is a signal to readers rather than a resolution input — but it is an
  honest one, which `0.0.0` never was.

  > **Amended by [ADR 0017](./0017-single-package.md).** Factories install
  > jigs from GitHub Packages now, pinned to one version, so the
  > number is a `pnpm update` coordinate as well as a signal; the `link:`
  > era, and the "`git pull` then `pnpm build`" recipe the amendment above
  > called temporary, are over. The wrapper file's upgrade path is
  > `jigs upgrade`: bump both pins, `jigs up`, then the factory's typecheck,
  > whose error on a jig's deps object names the wrapper a release added.
  > What a release cannot do for a factory — grow `steps/jigs.ts` — is
  > therefore reported at upgrade time rather than met as an unmemoized step
  > at run time.
- **The e2e fixture is the only place any of this is observable.** No pipeline
  lives in this repo, so `pnpm build` compiles no directive; a closed discovery
  gate, a collapsed namespace and a renamed id all build clean. `pnpm e2e` is
  the check, and its two builds are what make "the library can be versioned
  without renaming a memoization key" a tested property rather than a claim.

## Considered options

- **Generate the wrappers into `.jigs/` at build time**, alongside the
  generated server entry, so the factory commits nothing. Rejected by Salim on
  the pattern: a factory's `pipelines/` would import its steps from a build
  directory, a fresh clone would not typecheck until it had built once, and the
  step ids — which are these filenames — would be owned by a generator rather
  than by the repo they name. Committed source with an append offer keeps the
  ids where a human can see them (amended — the append offer is gone, so it is
  committed source and nothing else; the rejection stands on the three counts
  above, which never depended on it).
- **Patch the SDK's `module-specifier.js`** so a step in an installed package
  is addressed without its version. Rejected: it is a standing fork of a
  dependency on its fastest-moving surface, carried into every factory install,
  to change a derivation whose two answers are each correct for what they
  address. The boundary was the thing to move, not the SDK.
- **Keep the pin and never version the library.** The status quo ADR 0012
  chose. Rejected once the wrappers moved: the pin's only justification was
  ids that no longer exist, and a version field that must stay `0.0.0` is a
  landmine dressed as a convention — nothing enforces it but a test, and its
  failure mode is other people's parked runs.
- **A single dispatch step**, `call(name, ...)`, so a factory scaffolds one
  wrapper instead of fifteen. Rejected: every step in every run's history would
  then read as `call`, trading away the debugging legibility this dogfood era
  exists for.

## Known costs, accepted with eyes open

- Fifteen wrappers per factory, each a chance to lose durability silently — a
  wrapper that is missing or loses its directive is not an error, it is a
  function that runs unmemoized and re-fires on every replay. With the scaffold
  and drift warning gone (amended — boilerplate lives in the factory repo for
  now), the fixture and the factory's own id tests are the remaining guard.
- The step-id derivation still walks up to a workspace root the build tool
  detects rather than one jigs declares — untouched by this, and recorded in
  [ADR 0012](./0012-per-factory-service.md)'s known costs.
