# jigs — agent guide

See `README.md` for what jigs is and the dev commands (`pnpm check` runs lint,
typecheck, test, and build). `pnpm check` covers no workflow directive — no
pipeline lives here — so run `pnpm e2e` too: it scaffolds a factory with
`jigs init` into a temp dir, builds it, and diffs its emitted step ids against
`e2e/expected-ids.txt`.

PR titles are conventional commits, enforced by CI — the squashed title is what
release-please reads to cut a release
([ADR 0014](docs/adr/0014-release-automation.md)).

## Agent skills

### Issue tracker

Issues live in Linear — the **Jigs** project under the **Development (AGE)**
team, accessed via the `linear-personal` MCP server. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — the five canonical labels, names used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
