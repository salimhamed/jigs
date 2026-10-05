# @jigs-ai/hub — agent guide

The repo root's `AGENTS.md` covers commands, releases, docs and the issue
tracker. The hub publishes with jigs on every release, and as a preview from
the `hub` branch.

## Layout

- `src/` is the Express server; `app/` is the React Router web app, which
  reaches server state through the load context `src/web.ts` builds. Mount
  `/api/*`, `/webhooks/*` and `/oauth/*` routes in `src/main.ts`, ahead of the
  web app.
- Messages the hub exchanges with a factory belong in `@jigs-ai/hub-protocol`,
  not here, so jigs can share them.
- Store every secret encrypted through `src/secrets.ts`.

## Database

`src/db/schema.ts` holds every table. To change one, edit the schema, run
`pnpm --filter @jigs-ai/hub db:generate --name <change>`, and commit the SQL
and `migrations/meta/` it writes. The hub applies pending migrations on start.

Every factory message takes its position from one sequence, so a transaction
that appends messages calls `lockAppends` first.

## Providers

- A provider event goes only to the factories its app is assigned to.
- Webhook routes take `webhookBody` and check the signature before trusting
  the payload.
- Provider API URLs are replaced only in tests: an `apiUrl` option on a
  provider's functions and routes, and `apiUrls` on `createFactoryApi`.
- To add a provider, add it to `providers` in `@jigs-ai/hub-protocol`; the
  compiler then names every exhaustive switch to extend.
- An app's page (`app/routes/app.tsx`) and its website page
  (`site/guide/hub-<provider>.md`) both say what to set on the provider;
  change them together.

## Running and building

The hub runs from its environment only. The website's "Run a hub" page
(`site/guide/hub.md`) documents every setting; change it with
`src/config.ts`.

Anything the built hub imports must be a dependency, not a devDependency,
except the private `@jigs-ai/hub-protocol`, which the build bundles. Resolve
paths to `migrations/` and `build/` from `src/package-root.ts`, so they hold
from `src/` and `dist/` alike.

## Tests

Tests ending in `.db.test.ts` need Postgres and run under `pnpm test:db`,
which builds first. Provider and factory API tests start from
`setUpTestHub()` in `src/test-hub.ts`.

Keep `main.db.test.ts` passing: the built hub must exit 0 on SIGTERM once open
connections close, so its process manager can stop it.
