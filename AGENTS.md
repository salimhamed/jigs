# jigs — agent guide

See `README.md` for what jigs is and the dev commands (`pnpm check` runs lint,
typecheck, test, and build). `pnpm check` covers no workflow directive: library
code has none, and recipes compile inside factories. Run `pnpm e2e` too: it
builds a bare `jigs init` factory and one with `jigs recipe add ship` plus manual
workflow registration. Their emitted IDs are pinned in `e2e/expected-ids.bare.txt`
and `e2e/expected-ids.ship.txt`. With `WORKFLOW_POSTGRES_URL` set it also boots
the recipe factory service, waits for readiness, and requires a clean exit on
SIGTERM. CI provides Postgres; without the URL the boot is skipped.

PR titles are conventional commits, enforced by CI — the squashed title is what
release-please reads to cut a release
([ADR 0014](docs/adr/0014-release-automation.md)).

## Where code goes

`src` is split by what the Workflow SDK does with the code. The
README's Layout section has the tree and the reasoning. The rules a change has
to keep:

- `blocks/` is workflow-side. It may import other `blocks/` files, zod, the
  `workflow` SDK, and `import type` from anywhere. It may not import a *value*
  from a node built-in, read `process.env`, reach the network, or import a
  value from `steps/`, `service/`, `cli/`, `checks/`, `config/` or
  `providers/`.
- `steps/` is the real work. It may import `providers/`, `config/`, `checks/`,
  `errors.ts`, and `blocks/`. A step may call a block as a value because
  `blocks/` is pure by construction; the snapshot and step-result normalizers
  are called that way.
- `service/` is the long-running process. It may import `steps/`,
  `providers/`, `config/`, `checks/` and `blocks/`; the webhook ingress parses
  hook tokens that `blocks/` defines.
- A type used by one module stays in that module. A type used on both sides of
  the blocks/steps line lives in `blocks/`, under the same topic. There is no
  shared types folder.

No file under `src/` carries a `"use workflow"` or `"use step"` directive; both
live in factory code, including the copied recipes ([ADR 0013](docs/adr/0013-factory-owned-steps.md)). `pnpm e2e` is
what proves it, and it also scans the built workflow bundle for `node:`
specifiers and `process.env`.

## Compatibility

Jigs has no compatibility obligation. Change a contract in place: rename,
remove and reshape types, exports, config and durable addresses without shims,
deprecation paths, fallbacks for old callers or dual code paths. A breaking
change is a `!` in the PR title and one footer line in the commit, nothing more.
Factories adopt a release by upgrading and fixing what breaks.

## Doc comments

Write `/** */` comments for users with limited context, in plain language and as
briefly as clarity allows. Use summary prose, `@remarks` for longer rationale and
`@example` when it helps; use `@internal` to exclude an implementation detail.
Do not use `@param`, `@returns`, unknown tags, Linear tickets, ADR numbers or
`docs/adr/` paths. Every declaration exported directly from a package entry point
has a summary; nested members rely on their rendered TypeScript signatures unless
their meaning needs explanation. Every public entry point starts with
`@packageDocumentation`.
Maintainer `//` comments may cite an ADR, but never a Linear ticket.

## Agent skills

### Issue tracker

Issues live in Linear — the **Jigs** project under the **Development (AGE)**
team, accessed via the `linear-personal` MCP server. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — the five canonical labels, names used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Bespoke workflow direction

For factory layout refactors, bespoke workflow authoring, or changes to jigs'
execution API, read [the implementation plan](docs/bespoke-workflows-plan.md)
for the agreed ownership boundaries, rationale and staged acceptance criteria.
