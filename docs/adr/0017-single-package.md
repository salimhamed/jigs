# One published package at the repository root

jigs publishes one package, `@salimhamed/jigs`, containing its CLI, block and
step interfaces, service implementation, and factory scaffold. Factories pin
that package from GitHub Packages and run their own installed CLI. The earlier
private workspace root and nested published package were flattened because
there is only one package to build, test and release.

`src/`, `templates/`, the package manifest and build settings live at the root.
`pnpm-workspace.yaml` remains solely for pnpm dependency build permissions; it
has no package membership declaration. Release automation tracks the root
package, preserving the existing jigs release component and version history.

The package ships compiled JavaScript and declarations. Workflow SDK, Postgres
World, dashboard and zod versions are supplied as factory peers, so compilation
and service execution use the same runtime. Nitro is an optional peer for the
factory build. Durable directives remain factory-local (ADR 0013), allowing
ordinary package releases without putting the jigs version in step addresses.
