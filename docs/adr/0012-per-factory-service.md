# A service per factory repo

Each factory repo builds and runs its **own** service. A service is the long
lived process that hosts one factory's compiled pipelines, creates runs at the
trigger, resumes them on wakes, and hosts that factory's dashboard. Two
factories on one machine share nothing: each has its own service port, its own
dashboard port, its own Postgres World container, its own `.env` and its own
bindings. The factory owns its pipelines, its `jigs.config.ts` registry, its
World, its ports and its build output. jigs owns none of them. Delivered
across [#25](https://github.com/salimhamed/jigs/pull/25) to
[#28](https://github.com/salimhamed/jigs/pull/28).

> **Rewritten on 2026-09-11.** This ADR also carried the case for
> `@jigs/service` as a second package, shipped as raw TypeScript so a
> factory's own bundler could compile its `"use step"` files out of
> `node_modules`, and for pinning that package at version `0.0.0` forever
> because step ids carried it. Both halves are gone.
> [ADR 0013](./0013-factory-owned-steps.md) moved the wrappers into the
> factory, so no jigs package carries a directive and no step id carries a
> package name or version, and [ADR 0017](./0017-single-package.md) merged the
> two packages into `@salimhamed/jigs`. What survives is the decision above
> and the consequences below. The retired half is in git history.

## Why a service per factory and not one for the machine

A build root decides what the compiler treats as local code. One jigs owned
build pointed at a factory's `pipelines/` directory would give that factory's
own pipelines ids relative to a jigs checkout the factory does not contain,
and every factory on the machine would share one bundle, one port and one
World. So `jigs build` runs in the factory, with the factory's own nitro and
the factory's own copy of the SDK, and `jigs service start|stop|restart|
status|logs` supervises the result by pidfile.

Supervision is a pidfile per factory rather than a systemd unit per factory. A
unit per factory would put unit generation, naming and installation in the
CLI, and would grow a "which one" into every repair string.

## Consequences

- **The compiler and the runtime must be the same install.** `jigs build`
  resolves `prepare()` and the `nitro` binary from the factory root, never
  from a jigs checkout. Two copies of the SDK compile ids that the other copy
  does not register, and the failure is a run that hangs rather than an error.
- **The build entry is generated, not scaffolded.** `.jigs/server.ts` is
  rewritten by every `jigs build` rather than copied once by `jigs init`, so
  the seam can change without going stale in every factory that already
  exists. It is a real file and never a nitro alias: the workflow builder runs
  its own discovery pass that does not honour aliases, and an alias builds
  clean while emitting a manifest with no steps in it.
- **Each factory hosts its own dashboard, in the service process.** The SDK's
  observability UI cannot run beside the service, because opening the World
  also starts a queue worker: a standalone UI process steals the service's
  queue jobs and delivers them to its own port, where there is no workflow
  route. So the dashboard port is a second port the factory declares.
- **Amends [ADR 0008](./0008-adopt-workflow-sdk-runtime.md).** Its "long-lived
  server (systemd user unit)" and "Postgres in docker is standing
  infrastructure" were both written for one global service.
- **Amends [ADR 0010](./0010-preflight-in-trigger-path.md).** The two service
  credentials preflight checks come from the factory's own `.env`, not from a
  systemd `EnvironmentFile`.
- **Nothing in this repo compiles a workflow directive.** The demos left with
  the pipelines, so `pnpm build` cannot prove the packaging still works.
  `pnpm e2e` exists for that alone: it runs `jigs init` into a temp directory
  outside the repo, builds that factory, and diffs its emitted ids against
  `e2e/expected-ids.txt`. A closed discovery gate, a collapsed step namespace
  and a renamed id all build clean, so the id diff is the only place any of
  them is visible.

## Considered options

- **Compile the factory's pipelines from the service side**, so jigs keeps one
  build pointed at the factory's `pipelines/` directory. Rejected for the
  build-root reason above, and because it puts a build of the user's code
  inside a package the user is expected to upgrade.
- **A unit per factory under systemd.** Rejected for the CLI surface it grows.
  `jigs service restart` is the whole answer instead.

## Known costs, accepted with eyes open

- The step id derivation walks up to a workspace root that the build tool
  detects, not one jigs declares. A factory that is its own repo gets the
  right answer; a factory nested under another workspace does not. That is why
  `pnpm e2e` scaffolds its factory outside this repo.
