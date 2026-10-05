# jigs — agent guide

A pnpm workspace. Each package has its own `AGENTS.md`; read the one for the
package you change:

- `packages/jigs`: `@jigs-ai/jigs`, the published library, CLI and service.
  Its layering and Workflow SDK rules live in `packages/jigs/AGENTS.md`.
- `packages/hub`: `@jigs-ai/hub`, the hub server (private for now).
- `packages/hub-protocol`: messages between the hub and a factory, bundled
  into `@jigs-ai/jigs` (private).
- `tools/api-docs`: TypeDoc and VitePress tooling for `site/`.

`docs/contributing.md` has the dev commands and the layout. Run every command
from the repo root. Run `pnpm check` and `pnpm e2e` before you finish. `pnpm
e2e` builds factories from a packed `@jigs-ai/jigs` and diffs their durable
IDs. With `WORKFLOW_POSTGRES_URL` set it also boots the linear-ticket-to-pr
factory's service and requires a clean exit on SIGTERM. CI provides Postgres;
without the URL the boot is skipped, so say so when you report.

PR titles are conventional commits, enforced by CI: the squashed title is what
release-please reads to cut a release (see Releases in `docs/contributing.md`).
Every package shares the one version release-please cuts as `jigs-vX`;
`packages/jigs` and `packages/hub` publish.

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
`CONTEXT.md` is the maintainer vocabulary for `packages/jigs/src/`; use its terms.

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
