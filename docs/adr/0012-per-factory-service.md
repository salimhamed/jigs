# A service per factory repo, and @jigs/service as its library

> **Amended by [ADR 0013](./0013-factory-owned-steps.md).** The `"use step"`
> wrappers moved to the factory repo, so no jigs package carries a directive
> and no step id carries a package version. The `"version": "0.0.0"` pin below
> is gone: `jigs` and `@jigs/service` are both `0.1.0` on ordinary semver. The
> per-factory service and the library shape stand.

Each factory repo builds and runs its **own** service. `@jigs/service` stops
being an application and becomes the library that factory installs: the app
and its routes, the step, suspension and worktree primitives its pipelines are
written against, the Nitro config its build uses, and the templates `jigs init`
scaffolds from. The factory owns the pipelines, the `jigs.config.ts` registry,
the World, the port, the `.env` and the build output; jigs owns none of them.
`jigs build` compiles the factory's pipelines with the factory's own nitro and
its own copy of the SDK, and `jigs service start|stop|restart|status|logs`
supervises the result by pidfile. Delivered across
[#25](https://github.com/salimhamed/jigs/pull/25)–[#28](https://github.com/salimhamed/jigs/pull/28).

The blocking question was a compile question, and it was settled by
experiment, not by reading: **`"use workflow"` / `"use step"` directives
inside `node_modules` do compile.** The workflow builder follows imports out
of the factory into the installed package, transforms the directive-bearing
functions there, and emits one bundle whose `registerStepFunction` comes from
a single bare `workflow` specifier — so a factory-local step and a step from
`@jigs/service` register into the same registry, in the same process, once.
The condition is that the package be consumed as **raw TypeScript**: compiled
output has already had its directives stripped, and a stripped directive is
not an error, it is a step that silently is not one.

The second half of the answer is where step ids come from. The SDK derives
them at compile time from the **package name, that package's version, and the
export subpath the file was reached through** — `step//@jigs/service/steps@0.0.0//runAgentStep`.
Step ids are the memoization keys in the World, so all three inputs are
permanent identity, not metadata. Hence `@jigs/service` is pinned at
**`"version": "0.0.0"` forever**: a bump renames every step jigs owns at once,
and every run parked mid-flight replays against ids that no longer exist. There
is no migration for that, and nothing throws when it happens.

## Amended: the wrappers moved to the factory anyway (AGE-332)

The "put the directives in the factory repo" option below was rejected on the
count of wrappers, and that trade was re-taken once the cost of the other side
came due: a version baked into every memoization key means `@jigs/service` can
never be versioned at all, and `0.0.0` is a lie every reader has to be told.
So no jigs package carries a directive now. `@jigs/service` exports plain
implementation functions, the factory owns fifteen `"use step"` wrappers that
delegate to them, and ids are factory-local paths —
`step//./steps/jigs//worktree`, no version anywhere. The wrappers were
`jigs init` output when this was written, which is what made the
fifteen-chances risk a scaffolding problem rather than a per-factory one
(*amended by AGE-336*: they are hand-written committed source now, so the risk
is per-factory again — see the amendment below). The consequences
below still hold except where noted; the decision is recorded in full as
[ADR 0013](./0013-factory-owned-steps.md), which also removes the version pin.

## Amended: what the factory owns, and how it stays current (AGE-333)

The wrappers are **committed, human-owned source** in one file,
`steps/jigs.ts`, holding all fifteen and the jigs wired on top of them
(`reviewLoop`, `ticketReview`, `needsHuman`, `agent`, `gate`, …) with their
deps injected. Not generated into a `.jigs/` directory at build time: a fresh
clone has to typecheck before it has ever built, and the factory's own
filenames have to be the step ids. That makes the file's path and every
exported function name load-bearing exactly as `pipelines/` filenames already
are, which its header comment says in as many words.

`jigs init` no longer writes it at all (*amended by AGE-336*: the code
scaffold, the re-run append offer, and the `jigs build` drift warning were
removed — the boilerplate churned faster than the library, so it lives in the
operator's factory repo until the API stabilizes). A
`jigs steps sync` regenerate command was deliberately not built while the API
is still settling, and neither was a single-dispatch `call(name, ...)` step —
every step in run history would then read as `call`, which trades away the
debugging legibility this dogfood era is for.

**The wrapper bodies import their implementations at module scope.** That was
unverified — the pre-AGE-332 shims used `await import()` inside the body to
keep node builtins out of the workflow bundle — so it was settled by building
the fixture both ways: the workflow bundle is byte-identical. The directive
transform erases each wrapper body *and the imports only that body reaches*,
so a wrapper module compiles down to one stub line per step on the workflow
side, and `steps/jigs.ts` sitting on top of `@jigs/service/steps/run`,
`/worktrees` and `/review-loop/pull-request` pulls none of them across. The
e2e guard now asserts that directly: zero `node:` specifiers in the workflow
bundle, with the fixture's pipeline calling the jigs so they are genuinely in
it.

## Consequences

- **The exports map is compile-time contract, one literal entry per
  directive-bearing file.** A subpath is half an id, so a wildcard entry (which
  the SDK cannot match by exact string) collapses two modules into the package
  root namespace, and a missing entry is a module the factory cannot reach.
  `src/package.test.ts` guards the map, the pin, and the peer set. *Superseded
  by AGE-332*: with no directives left here a subpath is no longer half an id,
  so the map is an ordinary export map and the guard is inverted — it now
  asserts that no compiled source in the package carries a directive at all
  (`templates/` was exempt as the thing that scaffolded the wrappers into the
  factory; *amended by AGE-336*: it holds infrastructure only and no TypeScript
  at all, so the guard scans `src/` and `plugins/` and needs no exemption;
  *amended again*: the templates now live in the `jigs` package and ship with
  the CLI that scaffolds from them, so `jigs init` no longer needs a checkout
  to find them and the service package carries none). The
  pin guard went with the pin ([ADR 0013](./0013-factory-owned-steps.md)).
- **Nothing routes through the `.` export.** `src/factory.ts` is types only,
  deliberately: re-exporting a step module through `.` would change that
  module's subpath, and therefore its ids.
- **Two factories share nothing.** Each has its own World container on its own
  port, its own service port derived from its path, its own `.env`, its own
  bindings. *Amended by AGE-373*: and its own dashboard port. The SDK's
  observability UI has to run inside the service process rather than beside it,
  because opening the World also starts a queue worker — a standalone UI
  process steals the service's queue jobs and delivers them to its own port,
  where there is no workflow route. *Amends [ADR 0008](./0008-adopt-workflow-sdk-runtime.md)*, whose
  "long-lived server (systemd user unit)" and "Postgres in docker is standing
  infrastructure" were both written for one global service. Supervision is a
  pidfile per factory: a unit per factory would put unit generation, naming and
  installation in the CLI, and grow a "which one" into every repair string.
  *Amends [ADR 0010](./0010-preflight-in-trigger-path.md)* likewise — the two
  service credentials preflight checks come from the factory's `.env`, not from
  a systemd `EnvironmentFile`.
- **The compiler and the runtime must be the same install.** `jigs build`
  resolves `prepare()` and the `nitro` binary from the factory root, never from
  a jigs checkout: two copies of the SDK compile ids that the other copy does
  not register, and the failure is a run that hangs rather than an error.
- **The build entry is generated, not scaffolded.** `.jigs/server.ts` is
  rewritten by every `jigs build` rather than copied once by `jigs init`, so
  the seam can change without going stale in every factory that already exists.
  It is a real file and never a nitro alias: the workflow builder runs its own
  discovery pass that does not honour aliases, and an alias builds clean while
  emitting a manifest with no steps in it.
- **Nothing in this repo compiles a workflow directive any more.** The demos
  left with the pipelines, so `pnpm build` cannot prove the packaging still
  works. `e2e/fixture-factory` exists for that alone: one pipeline exercising a
  factory-local workflow body, a factory-local inline step, and a
  factory-owned `steps/jigs.ts` delegating to `@jigs/service` in
  `node_modules` (*amended by AGE-332*, which replaced the imported-step path,
  and by AGE-336, which made the fixture's copy the worked example rather than
  a scaffold mirror),
  with the emitted ids diffed against a checked-in list.
  A closed discovery gate, a collapsed step namespace, and a renamed id all
  build clean — the id diff is the only place they are visible.
  *Amended by AGE-333*: the guard builds the fixture twice, the first time with
  `@jigs/service` on a fake version, and asserts the ids do not move. That the
  library can be versioned without renaming a memoization key is the property
  this whole shape was bought for, and nothing else can observe it.

## Considered options

- **Compile the factory's pipelines from the service side** — jigs keeps one
  build, pointed at the factory's `pipelines/` directory. Rejected: the build
  root determines what the compiler treats as local, so the factory's own
  pipelines would take ids relative to a jigs checkout that the factory does
  not contain, and every factory on the machine would share one bundle, one
  port and one World. It also puts a build of the user's code inside a package
  the user is expected to upgrade.
- **Put the `"use step"` directives in the factory repo** — `@jigs/service`
  exports plain functions and each factory declares its own directive-bearing
  wrappers, which sidesteps the node_modules compile question entirely.
  Rejected once the experiment settled that question: it needs roughly fifteen
  delegating wrappers per factory, most of them for machinery a pipeline author
  never names (the agent-step shim, the PR-gate poll, the snapshot fetch, the
  teardown step), and a wrapper that is missing or loses its directive is not
  an error — the function simply runs unmemoized in the workflow sandbox and
  re-fires on every replay. Fifteen chances per factory to silently lose
  durability, against one packaging invariant tested in one place.
- **Ship `@jigs/service` as compiled output** — conventional packaging, and it
  makes `exports` an ordinary concern rather than compile-time contract.
  Rejected: the directives do not survive the compile, and their absence is
  silent.

## Known costs, accepted with eyes open

- The version can never move. `@jigs/service` gets no semver signal at all;
  what changed between two factory installs is a git question. *Retired by
  [ADR 0013](./0013-factory-owned-steps.md)*: no id carries the version, the
  pin is gone, and both packages are at `0.1.0` on ordinary semver. Retired
  with it: the exports-map exact-string trap (the first consequence above
  records that). The peer set stays for its other reason, one copy of
  `workflow` per process.
- A factory installs the SDK, its World, its dashboard and zod itself, and
  those pins must match the ones `@jigs/service` peers on. The factory
  `package.json` template carries the same versions, and `src/package.test.ts`
  fails when the two drift.
- The step-id derivation walks up to a workspace root that the build tool
  detects, not one jigs declares. A factory that is its own repo gets the right
  answer; a factory nested under another workspace does not, which is why
  `e2e/fixture-factory` has to name its own `workspaceDir` to reproduce a real
  factory from inside this repo.
