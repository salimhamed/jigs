# jigs — agent guide

See `README.md` for what jigs is and the dev commands (`pnpm check` runs lint,
typecheck, test, and build). `pnpm check` covers no workflow directive — no
pipeline lives here — so run `pnpm e2e` too: it scaffolds a factory with
`jigs init` into a temp dir, builds it, and diffs its emitted step ids against
`e2e/expected-ids.txt`. With `WORKFLOW_POSTGRES_URL` set it also boots the
built service, waits for it to be ready, and requires a clean exit on SIGTERM;
CI provides that Postgres, and without the URL the boot is skipped.

PR titles are conventional commits, enforced by CI — the squashed title is what
release-please reads to cut a release
([ADR 0014](docs/adr/0014-release-automation.md)).

## Where code goes

`packages/jigs/src` is split by what the Workflow SDK does with the code. The
README's Layout section has the tree and the reasoning. The rules a change has
to keep:

- `blocks/` is pipeline-side. It may import other `blocks/` files, zod, the
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

No file here carries a `"use workflow"` or `"use step"` directive; both live in
a factory ([ADR 0013](docs/adr/0013-factory-owned-steps.md)). `pnpm e2e` is
what proves it, and it also scans the built workflow bundle for `node:`
specifiers and `process.env`.

## Agent skills

### Issue tracker

Issues live in Linear — the **Jigs** project under the **Development (AGE)**
team, accessed via the `linear-personal` MCP server. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — the five canonical labels, names used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
