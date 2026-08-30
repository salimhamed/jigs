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

## Consequences

- **The factory's `steps/jigs.ts` path and its exported function names are
  permanent names.** Each one *is* half a durable step id, exactly as the
  filenames in `pipelines/` are. Renaming the file, moving it, or renaming an
  exported wrapper orphans every run that factory has parked, and the build
  stays green while it happens. The file's own header comment says so, and
  `docs/setup.md` says it again at the point a reader first sees the file.
- **The wrappers are committed source, maintained by an offer rather than a
  regenerate.** `jigs init` writes the file once and never rewrites it; on a
  re-run it diffs the factory's copy against the scaffold and offers to append
  the wrappers jigs has grown since — the offer pattern `jigs bind` already
  uses — and `jigs build` warns about the same drift with the re-run as its
  repair. `packages/service/templates/steps/jigs.ts.tmpl` is the single list of
  steps, so a wrapper added there reaches every factory through that offer.
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
  ids where a human can see them.
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
  function that runs unmemoized and re-fires on every replay. The mitigation is
  that they are scaffold output rather than hand-written, that the fixture
  compiles the scaffold verbatim, and that `jigs build` warns on drift.
- The step-id derivation still walks up to a workspace root the build tool
  detects rather than one jigs declares — untouched by this, and recorded in
  [ADR 0012](./0012-per-factory-service.md)'s known costs.
