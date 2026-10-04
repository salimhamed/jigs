# @jigs-ai/hub — agent guide

The repo root's `AGENTS.md` covers commands, releases, docs and the issue
tracker. The hub stays private until it ships.

## Layout

- `src/` is the server, which `node` runs from source. `main.ts` reads the
  environment once (`config.ts`), applies migrations, then listens.
  `server.ts` is the Express app: add `/api/*` and `/webhooks/*` routes there,
  ahead of the web app.
- `app/` is the React Router web app (Vite, Tailwind, Radix). Loaders reach
  server state through the load context that `src/web.ts` builds.
- `src/secrets.ts` encrypts every secret the hub stores with
  `HUB_ENCRYPTION_KEY`. Store secrets only in that encrypted form.

## Database

Drizzle on `pg`. `src/db/schema.ts` holds every table. To add or change one,
edit the schema, then run
`pnpm --filter @jigs-ai/hub db:generate --name <change>` and commit the SQL and
`migrations/meta/` it writes. The hub applies pending migrations on start.

## Running

Set `HUB_PUBLIC_URL`, `HUB_DATABASE_URL` and `HUB_ENCRYPTION_KEY`
(`openssl rand -base64 32`); `HOST` and `PORT` are optional. `dev` serves the
web app through Vite and reads `packages/hub/.env`; `build` then `start` runs
the production app. Tests ending in `.db.test.ts` need Postgres and run under
`pnpm test:db`, which builds the app first.

Keep `main.db.test.ts` passing: the built hub must exit 0 on SIGTERM once open
connections close, so its process manager can stop it.

Messages the hub exchanges with a factory belong in `@jigs-ai/hub-protocol`,
not here, so jigs can share them.
