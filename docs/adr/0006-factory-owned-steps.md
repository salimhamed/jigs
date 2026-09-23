# Factory-local durable steps with generated integration

Status: accepted

The Workflow SDK addresses a package's steps by package name, version and
export path, and a factory's own steps by file path and function name. So no
file under jigs' `src/` carries a `"use workflow"` or `"use step"` directive;
library implementations are plain functions, and every directive lives in the
factory. Upgrading jigs does not rename a factory's durable addresses.

The factory commits a generated root `jigs.ts`: explicit named step wrappers,
plus blocks bound to them through `bindAgentSteps`, `bindLinearSteps`,
`bindPullRequestSteps` and `bindReleaseSteps`. `jigs generate` rewrites it from
the installed package and `jigs upgrade` runs it. A build never edits source:
it fails when `jigs.ts` differs from the installed template. Committing the
file keeps a fresh clone typecheckable and the addresses reviewable.

jigs ships as one package, `@jigs-ai/jigs`. The Workflow SDK, Postgres World,
dashboard and zod are its peer dependencies (Nitro an optional one), so the
factory's compile and its service run on the same runtime.

## Consequences

- Custom code never goes in `jigs.ts`. A custom block binds only the
  capabilities it needs, with replacement steps in the factory; a custom
  renderer is imported inside that step, not passed across a durable call.
- Renaming a library export or changing the template moves step ids, a
  breaking change: runs in flight must finish or be cancelled before deploy.
- `pnpm e2e` builds scaffolds against two library versions and compares the
  emitted ids, and scans the workflow bundle for `node:` imports and
  `process.env`. Unit tests cannot observe either property.
- Generating wrappers only at build time was rejected: fresh clones would lack
  source and addresses would be hidden. A generic dispatch step was rejected:
  named operations stay inspectable.
