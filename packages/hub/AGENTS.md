# @jigs-ai/hub — agent guide

The repo root's `AGENTS.md` covers commands, releases, docs and the issue
tracker. The hub publishes only as a preview, from the `hub` branch.

## Layout

- `src/` is the server. `main.ts` reads the
  environment once (`config.ts`), applies migrations, then listens.
  `server.ts` is the Express app: add `/api/*` and `/webhooks/*` routes there,
  ahead of the web app.
- `app/` is the React Router web app (Vite, Tailwind, Radix). Loaders reach
  server state through the load context that `src/web.ts` builds.
- `src/auth.ts` is Better Auth: GitHub sign-in, invite-only, and the
  organization plugin for Organizations, members and invites. It mounts at
  `/api/auth/*`. Loaders and actions call `context.auth.api` through
  `app/auth.server.ts`; pages under `routes/organization.tsx` need a member.
- `src/secrets.ts` encrypts every secret the hub stores with
  `HUB_ENCRYPTION_KEY`. Store secrets only in that encrypted form.

## Database

Drizzle on `pg`. `src/db/schema.ts` holds every table. To add or change one,
edit the schema, then run
`pnpm --filter @jigs-ai/hub db:generate --name <change>` and commit the SQL and
`migrations/meta/` it writes. The hub applies pending migrations on start.

## Running

Set `HUB_PUBLIC_URL`, `HUB_DATABASE_URL`, `HUB_ENCRYPTION_KEY`
(`openssl rand -base64 32`, which also derives the session secret),
`HUB_GITHUB_CLIENT_ID` and `HUB_GITHUB_CLIENT_SECRET` (a GitHub OAuth app whose
callback is `<HUB_PUBLIC_URL>/api/auth/callback/github`) and `HUB_ADMIN_EMAIL`
(the GitHub email that may create the first Organization); `HOST`, `PORT` and
`HUB_RETENTION_DAYS` (how long factory messages are kept, default 7) are
optional. `dev` runs the
server from source, serves the web app through Vite and reads
`packages/hub/.env`. `build` bundles the server into `dist/main.js` with tsdown
(Node will not strip types under `node_modules`) and the web app into `build/`;
`start` runs `dist/main.js` in production mode, as does the published
`jigs-hub` bin. The package ships `bin/`, `dist/`, `build/` and `migrations/`;
anything the built hub imports must be a dependency, not a devDependency.
Paths to `migrations/` and `build/` resolve from `src/package-root.ts`, so
they hold from `src/` and `dist/` alike. Tests ending in `.db.test.ts` need
Postgres and run under `pnpm test:db`, which builds first.

Keep `main.db.test.ts` passing: the built hub must exit 0 on SIGTERM once open
connections close, so its process manager can stop it.

Messages the hub exchanges with a factory belong in `@jigs-ai/hub-protocol`,
not here, so jigs can share them.

## Factory messages

`src/factory-api.ts` serves the factory's long poll and cursor. Every message
for every factory takes its position from one sequence, so any transaction
that appends messages calls `lockAppends` first (see `src/messages.ts`).
`fanOutProviderEvent` stores a provider event and wakes the factories it was
appended for; `src/retention.ts` deletes expired messages hourly.
