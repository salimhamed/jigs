# jigs

> In manufacturing, a jig guides tools through repeatable operations.
> In software, Jigs guides coding agents through repeatable workflows.

A lights-on software development factory: define pipelines that take tickets
through implementation, review, and iteration by AI agents — blocking for
human approval where it matters.

**Status:** a library and a CLI, not an application. Pipelines live in
**factory repos**, one per user: `jigs init` scaffolds one, `jigs build`
compiles its pipelines into a service of its own on the Vercel Workflow SDK
over its own Postgres World, and `jigs service start` (`stop` / `restart` /
`status` / `logs`) supervises it. The CLI manages repo bindings
(`jigs bind` / `unbind` / `bindings`) in that factory's committed `jigs.yml`,
which also carries the port its service answers on. Every trigger preflights
the pipeline's requirements before creating a run, and `jigs doctor` runs the
same checks on demand. The operational verbs are `jigs run` / `ps` / `logs` /
`cancel` / `poke`, each an HTTP client of the factory's own service; a run can
be named by its id, a unique id prefix, or the ticket it claimed.
`jigs cancel <run>` is the escape hatch for a zombie claim owner, and logs
themselves stay the SDK's — the verbs print the `workflow web` invocation that
reads the factory's own World. Pipelines request worktrees and the runtime
provisions and tears them down; `jigs sweep` reconciles what is on disk
against the registry. The [setup runbook](docs/setup.md) walks all of it: the
machine once, then a factory at a time.

## Layout

pnpm workspace:

- `packages/jigs` — the library-first package and `jigs` CLI.
- `packages/service` — `@jigs/service`, the library a factory repo installs:
  the app and its health/trigger/resume/run routes, the step, suspension and
  worktree primitives pipelines are written against, the Nitro build config,
  and the infrastructure templates `jigs init` scaffolds from. It carries no
  workflow directive of its own and has no build step: it ships as raw
  TypeScript and the factory's own build compiles it.
- `e2e/fixture-factory` — a one-pipeline factory repo carrying its own
  `steps/jigs.ts`, `jigs.config.ts` and pipeline, built in CI twice: once as
  committed and once with `@jigs/service` on a fake version, its emitted step
  ids diffed against a checked-in list both times. The only test that can see
  a factory-owned step wrapper still take a factory-local, version-free id —
  and the worked example a new factory copies its boilerplate from.

Both packages carry ordinary semver. Every `"use step"` wrapper lives in the
factory that runs it, so no step id carries a jigs version and a release never
renames a memoization key — [ADR 0013](docs/adr/0013-factory-owned-steps.md).

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build (all packages)
pnpm e2e        # build e2e/fixture-factory twice and diff its step ids
```

No pipeline lives in this repo, so `pnpm build` compiles no workflow
directive — `pnpm e2e` is what proves that half still works.
