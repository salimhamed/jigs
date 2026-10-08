# Factory step files built into `.jigs/`

Status: accepted

The Workflow SDK names every step after where its code lives. A step in the
app gets `step//./<path-from-root-without-extension>//<function>`; a step in
`node_modules` gets `step//<package><subpath>@<version>//<function>`. The name
is set in `@workflow/builders` (`resolveModuleSpecifier`), is not configurable,
and has no alias or explicit-id feature. A waiting run whose step name changed
fails on replay. jigs keeps two rules:

1. No file under jigs' `src/` contains `"use workflow"` or `"use step"`;
   library implementations are plain functions.
2. Step names never depend on the SDK keeping anything stable.

The package ships `factory/steps.ts` (explicit named `"use step"` wrappers
around library steps) and `factory/routines.ts` (the library's routines bound
to those wrappers) as source outside `src/`. `prepare()` (run by every build,
including `jigs up`) writes them into the factory's gitignored `.jigs/` beside
`server.ts` and `service.ts`. A factory's step ids are therefore
`step//./.jigs/steps//<function>`, with no version in them, and upgrading jigs
renames nothing unless a wrapper itself is renamed.

The factory imports them as `#jigs/steps` and `#jigs/routines`. Its
`package.json` `imports` maps each with conditions: `types` points at a
types-only package export (`@jigs-ai/jigs/factory/steps`, built from the same
file, with no runtime entry), `default` at `./.jigs/steps.ts`. TypeScript reads
the types, so a fresh clone typechecks before any build; the SDK's esbuild
discovery pass honours `package.json` `imports` and lands on `.jigs/`. A Vitest
plugin from the package runs `prepare()` before tests import the files.

Upgrading jigs is: edit the versions in `package.json`, `pnpm install`,
`jigs up`. Before restarting the service, `jigs up` compares the step ids that
waiting or running runs recorded with the new build's manifest, and stops,
naming the runs, if any are missing. That also covers authors renaming their
own steps.

jigs ships as one package, `@jigs-ai/jigs`. The Workflow SDK, Postgres World,
dashboard and zod are its peer dependencies (Nitro an optional one), so the
factory's compile and its service run on the same runtime.

## Consequences

- Factory source holds no jigs-owned code. Custom steps live beside the
  workflow that owns them; a custom routine binds only the capabilities it
  needs, with replacement steps in the factory, and a custom renderer is
  imported inside that step, not passed across a durable call.
- Renaming or removing a wrapper in `factory/steps.ts` moves step ids, a
  breaking change: runs in flight must finish or be cancelled before deploy.
- The SDK's discovery pass skips `node_modules`, `.nitro`, `.output`, `.swc`
  and `.nuxt` but not `.jigs`, which is what lets it find the wrappers. A
  wrapper whose `"use step"` body is one line is not registered, so wrappers
  stay multi-line.
- `pnpm e2e` builds factories against two library versions and compares the
  emitted ids, and scans the workflow bundle for `node:` imports and
  `process.env`. Unit tests cannot observe either property.

## Rejected

- **Stable package step ids from the SDK.** They don't exist, and we are not
  asking upstream for them.
- **The SDK's `__builtin*` names.** Internal, collision-prone, and the
  maintainers have tried to remove them (vercel/workflow#1607).
- **Virtual modules or a Nitro alias for the wrappers.** The SDK's discovery
  pass doesn't see them; that is also why `.jigs/server.ts` is a real file.
- **Generating on `pnpm install` (postinstall).** Breaks under
  `--ignore-scripts` and cached Docker layers.
- **Directives in jigs, accepting renames.** Breaks rule 1 and every in-flight
  run on every release.
- **Keeping old deployments running for old runs.** Only world-vercel pins runs
  to a deployment; world-postgres has no such thing.
- **A committed `jigs/` folder in each factory**, rewritten by `jigs generate`
  and `jigs upgrade` with a drift check. The previous design; the most
  machinery and churn for the same ids.
- **Aliasing a package path such as `@jigs-ai/jigs/steps` to `.jigs/`.** Four
  aliases (tsconfig, Nitro, Vitest and others) must agree, the same import
  names two files, and a mismatch fails quietly.
- **A generic dispatch step.** Named operations stay inspectable.
