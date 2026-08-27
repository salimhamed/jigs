# jigs

> In manufacturing, a jig guides tools through repeatable operations.
> In software, Jigs guides coding agents through repeatable workflows.

A lights-on software development factory: define pipelines that take tickets
through implementation, review, and iteration by AI agents — blocking for
human approval where it matters.

**Status:** runtime service skeleton plus factory config. Pipelines run on
the Vercel Workflow SDK with a self-hosted Postgres World; the CLI manages
repo bindings (`jigs bind` / `unbind` / `bindings`) in a committed `jigs.yml`.
Every trigger preflights the pipeline's requirements before creating a run,
and `jigs doctor` runs the same checks on demand. The operational verbs are
`jigs run` / `ps` / `logs` / `cancel` / `poke`, each an HTTP client of the
service; a run can be named by its id, a unique id prefix, or the ticket it
claimed. `jigs cancel <run>` is the escape hatch for a zombie claim owner —
it releases every resource the run holds so the same ticket can be launched
again, and `--force` skips its confirmation for a run still in flight. Logs
themselves stay the SDK's: the verbs print
`npx workflow web --backend @workflow/world-postgres <run>`, naming the world
the service writes to; run it with `WORKFLOW_POSTGRES_URL` in your shell.

## Layout

pnpm workspace:

- `packages/jigs` — the library-first package and `jigs` CLI.
- `packages/service` — the private Nitro app that owns execution: compiled
  pipelines, health/trigger/resume/run routes.
- `deploy/` — Postgres World compose file, systemd user unit, and the
  [deploy runbook](deploy/README.md).

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build (all packages)
```

To run the service locally see [deploy/README.md](deploy/README.md).
