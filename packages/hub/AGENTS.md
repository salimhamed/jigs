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
anything the built hub imports must be a dependency, not a devDependency,
except the private `@jigs-ai/hub-protocol`, which the build bundles.
Paths to `migrations/` and `build/` resolve from `src/package-root.ts`, so
they hold from `src/` and `dist/` alike. Tests ending in `.db.test.ts` need
Postgres and run under `pnpm test:db`, which builds first.

Keep `main.db.test.ts` passing: the built hub must exit 0 on SIGTERM once open
connections close, so its process manager can stop it.

Messages the hub exchanges with a factory belong in `@jigs-ai/hub-protocol`,
not here, so jigs can share them.

## Factory messages

`src/factory-api.ts` serves the factory's long poll and cursor, its status
(the apps assigned to it) and its provider tokens. Every message
for every factory takes its position from one sequence, so any transaction
that appends messages calls `lockAppends` first (see `src/messages.ts`).
`fanOutProviderEvent` stores a provider event and wakes the factories it was
appended for; `src/retention.ts` deletes expired messages hourly.

## Apps

`src/apps.ts` holds what every provider's apps share: installations and
assignments. A provider event goes only to the factories its app is assigned
to, so `fanOutProviderEvent` takes the app. `src/github.ts` adds GitHub Apps:
an admin enters an App made by hand; each App's setup URL confirms an
installation with the App's JWT before recording it; `/webhooks/github` finds
the app by `X-GitHub-Hook-Installation-Target-ID`, checks its signature, and
re-lists the App's installations from GitHub before dropping an event from one
it does not know. `GitHubTokens` mints installation tokens for factories with
the App's JWT and keeps them in memory only, never in the database; the bot
user's id is looked up once and kept in the app's settings. Tests pass
`apiUrl` to stand in for GitHub's API.

`src/linear.ts` adds Linear apps: an admin enters an OAuth app made by hand,
then connects each workspace through Linear's OAuth flow as the app
(`actor=app`), with the state checked against an HttpOnly cookie. Each
workspace's access and refresh tokens live encrypted on its installation;
`LinearTokens` refreshes them one at a time per workspace, since Linear
rotates the refresh token, and a refused refresh marks the installation as
needing a reconnect (`src/oauth.ts` holds that refresh, shared with
PagerDuty). Each Linear app has its own webhook URL, because Linear's
payloads do not name the app. On a new agent session the hub posts the first
activity itself, as Linear wants one within ten seconds.

`src/slack.ts` adds Slack apps: "Add to Slack" runs Slack's OAuth v2 and
stores each workspace's bot token. Every Slack app shares `/webhooks/slack`;
the hub finds the app by `api_app_id`, checks the signing secret, answers
URL verification with any Slack app's secret (the challenge names no app),
answers 200 to events it cannot place so Slack stops retrying, and drops a
retry of an event it already stored. `src/pagerduty.ts` adds PagerDuty
connections: one account each, connected through PagerDuty's OAuth with
PKCE (the account is read from the id token), with a webhook URL per
connection whose signing secret is entered after the subscription exists.
