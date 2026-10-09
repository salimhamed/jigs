# @jigs-ai/jigs — agent guide

The repo root's `AGENTS.md` covers commands, releases, docs and the issue
tracker. Paths below are relative to this package.

`pnpm check` compiles no workflow directive: library code has none, and recipes
compile inside factories. `pnpm e2e` builds a bare `jigs init` factory and one
with `jigs recipe add linear-ticket-to-pr`, and diffs their durable IDs against
`e2e/expected-ids.bare.txt` and `e2e/expected-ids.linear-ticket-to-pr.txt`.

## Where code goes

`src` is split by what the Workflow SDK does with the code. The rules a change
has to keep:

- `workflow/` is code that runs inside the workflow bundle. It may import
  other `workflow/` files, zod, the `workflow` SDK, and `import type` from
  anywhere. It may not import a *value* from a node built-in, read
  `process.env`, reach the network, or import a value from `steps/`,
  `service/`, `cli/`, `checks/`, `config/` or `providers/`.
- `steps/` is code that runs in steps. It may import `providers/`,
  `config/`, `checks/`, `errors.ts`, and `workflow/`. A step may call a
  `workflow/` function as a value because `workflow/` is pure by
  construction; the snapshot and step-result normalizers are called that way.
- `service/` is the long-running process. It may import `steps/`,
  `providers/`, `config/`, `checks/` and `workflow/`; routing a provider
  event parses hook tokens that `workflow/` defines. It may not import `cli/`.
- `steps/` may not import `service/` or `cli/`.
- `providers/` holds the provider clients with their checks. It may not import `steps/`, `service/`, `cli/` or `checks/`, except
  the `Check` shape in `checks/check.ts`.
- `config/` may not import `steps/`, `service/` or `cli/`.
- `checks/` may not import `service/` or `cli/`.
- `build/` writes the scaffold and the factory's `.jigs/` files, used by the CLI
  and the service build. It may not import `service/` or `cli/`.
- No value-import cycles.
- A type used by one module stays in that module. A type used on both sides of
  the workflow/steps line lives in `workflow/`, under the same topic. There is
  no shared types folder.
- A factory imports the library from the root `@jigs-ai/jigs`. Routines that
  take steps as arguments go in `src/workflow/routines.ts`, which only
  `factory/routines.ts` imports; never add them to the root.
- Extract a shipped routine only when a recipe and at least one other concrete
  workflow use the same mechanism; single-caller composition stays in the recipe.

`pnpm lint` runs dependency-cruiser with these rules, and biome forbids
`process.env` everywhere but `src/config/factory-context.ts` and tests: read a
setting through `currentFactoryContext().env`, and an environment for a child
process through `processEnv()`. `processEnv()` is never a factory setting: a
token, key or any other value from the factory's environment goes through
`ctx.env`. jigs reads only the process environment; loading files into it, such
as `.env.local` and `.env`, is the factory's own `jigs.config.ts`'s job.

No file under `src/` carries a `"use workflow"` or `"use step"` directive; both
live in `factory/steps.ts` and in factory code, including the copied recipes
([ADR 0006](../../docs/adr/0006-factory-owned-steps.md)). `pnpm e2e` proves it, and
also scans the built workflow bundle for `node:` specifiers and `process.env`.

A factory reaches providers only through its hub: provider events arrive in
`service/hub-client.ts`, and every GitHub, Linear, Slack and PagerDuty token
comes from `providers/hub.ts`. A new provider feature takes the same two
paths, and the factory's environment holds no provider secret.

`@jigs-ai/hub-protocol` is private, so tsdown bundles it into `dist/`. Add it
as a devDependency, never a dependency, and keep its types out of the public
declarations: the dts build only emits files inside this package.

## Compatibility contracts

`@jigs-ai/jigs/steps` exports only what a custom agent step uses:
`createAgentRunner`, `AgentRunner`, `AgentRunnerOptions`, `RunMetadata`,
`AgentSessionError` and `ProviderApiError`. Their shapes are a published
contract pinned by `src/steps/contract.test.ts`, and `src/package.test.ts`
pins the list; changing either is a breaking release. Drivers stay internal.

The delivery routines (`buildAndReview`, `publishPullRequest`,
`followPullRequestToOutcome`) run steps inside a factory's runs, and a parked
run replays them on the new release. A change to the steps they run, or to
their order, is a breaking release whose notes tell factories to let parked
runs finish before upgrading.

