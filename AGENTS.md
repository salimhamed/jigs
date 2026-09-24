# jigs — agent guide

`docs/contributing.md` has the dev commands and the source layout. Run
`pnpm check` and `pnpm e2e` before you finish. `pnpm check` compiles no workflow
directive: library code has none, and recipes compile inside factories. `pnpm e2e`
builds a bare `jigs init` factory and one with
`jigs recipe add linear-ticket-to-pr`, and diffs their durable IDs against
`e2e/expected-ids.bare.txt` and `e2e/expected-ids.linear-ticket-to-pr.txt`. With
`WORKFLOW_POSTGRES_URL` set it also boots the linear-ticket-to-pr factory's
service and requires a clean exit on SIGTERM. CI provides
Postgres; without the URL the boot is skipped, so say so when you report.

PR titles are conventional commits, enforced by CI: the squashed title is what
release-please reads to cut a release
([ADR 0007](docs/adr/0007-release-automation.md)).

## Where code goes

`src` is split by what the Workflow SDK does with the code. The rules a change
has to keep:

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
- Extract a shipped block only when a recipe and at least one other concrete
  workflow use the same mechanism; single-caller composition stays in the recipe.

No file under `src/` carries a `"use workflow"` or `"use step"` directive; both
live in factory code, including the copied recipes
([ADR 0006](docs/adr/0006-factory-owned-steps.md)). `pnpm e2e` proves it, and
also scans the built workflow bundle for `node:` specifiers and `process.env`.

## Compatibility

Jigs has no compatibility obligation. Change a contract in place: rename,
remove and reshape types, exports, config and durable addresses without shims,
deprecation paths, fallbacks for old callers or dual code paths. A breaking
change is a `!` in the PR title and one footer line in the commit, nothing more.
Factories adopt a release by upgrading and fixing what breaks.

## Docs

The website (`site/`) is the only user documentation; `docs/` holds maintainer
notes and ADRs. Anything public (site pages, README, skills, templates, doc
comments) cites no ADR, Linear ticket, `CONTEXT.md` or `docs/` path.
`CONTEXT.md` is the maintainer vocabulary for `src/`; use its terms.

Write `/** */` comments for users with limited context, in plain language and as
briefly as clarity allows. Use summary prose, `@remarks` for longer rationale and
`@example` when it helps; use `@internal` to exclude an implementation detail.
Do not use `@param`, `@returns` or unknown tags. Every declaration exported
directly from a package entry point has a summary; nested members rely on their
rendered TypeScript signatures unless their meaning needs explanation. Every
public entry point starts with `@packageDocumentation`. Maintainer `//` comments
may cite an ADR, but never a Linear ticket.

## Issue tracker

Issues live in Linear, in the **Jigs** project
(`cba18af1-71f0-4a08-bdec-24b5c88b1ec9`) of the **Development** team (key
`AGE`, `1a7c511f-7779-4da3-ba3b-71d8943e8471`), through the `linear-personal`
MCP server.

- Create with `save_issue` (team `Development`, project `Jigs`); read with
  `get_issue` on `AGE-<n>` and `list_comments`; list with `list_issues`
  filtered by project `Jigs`.
- Comment with `save_comment`. Set labels by passing `labels` to `save_issue`.
- Close by setting state `Done`, or `Canceled` for won't-fix.
- Triage labels, used as-is: `needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix`.
