# Factory-local durable steps with generated integration

The Workflow SDK addresses an installed package's steps by package name,
version and export path; factory-local steps use their file path and function
name. jigs keeps all directives in factories so upgrading the library does not
rename their durable addresses. Library implementations are plain functions.

The factory commits a generated root `jigs.ts` containing explicit named step
wrappers and blocks bound to those wrappers through independent agent, integration and delivery binders. This replaces
the manually maintained `steps/jigs.ts` and `blocks/jigs.ts`. `jigs generate`
refreshes the integration from the installed package, and `jigs upgrade` runs
that command after installation. Normal builds check for drift without editing
source. Committing the generated file keeps a fresh clone typecheckable and the
addresses reviewable. Custom code and prompt choices never belong in it.

Custom blocks can bind just the capabilities they need with replacement factory-local steps. A custom
comment renderer is imported inside that step, not passed across a durable call.
This preserves customization without teaching a generator to rewrite user code.

The consolidation deliberately changes step paths and improves exported names.
Existing runs must finish or be cancelled before deploying that migration.
Future renames remain possible breaking changes. The end-to-end scaffold build
checks emitted IDs across two library versions and scans the workflow bundle
for Node/environment leakage; library unit tests cannot observe those properties.

Generating ignored wrappers only during build was rejected because fresh clones
would lack source and durable addresses would be hidden. A generic dispatch step
was rejected because explicit named operations remain easy to inspect. Neither
reason requires preserving old names when a coordinated migration improves them.
