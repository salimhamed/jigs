# Deploying the jigs service

From a clean checkout to a running service (Linux, systemd user session).
Requires Node >= 24, pnpm, and docker.

## 1. Install and build

```sh
pnpm install
pnpm build
```

## 2. Postgres World

```sh
docker compose -f deploy/docker-compose.yml up -d --wait
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5439/jigs \
  pnpm --filter @jigs/service exec bootstrap
```

`bootstrap` is idempotent — re-run it freely (it applies the SDK's
migrations and the graphile-worker schema).

## 3. systemd user unit

```sh
mkdir -p ~/.config/jigs
cp deploy/systemd/jigs-service.env.example ~/.config/jigs/service.env
cp deploy/systemd/jigs-service.service ~/.config/systemd/user/
# Adjust WorkingDirectory in the unit if your checkout lives elsewhere,
# and ExecStart if node comes from a version manager (see the unit's
# header comment).
systemctl --user daemon-reload
systemctl --user enable --now jigs-service
curl -s http://localhost:8990/health
loginctl enable-linger "$USER"   # lights-on: survive logout
```

`~/.config/jigs/service.env` is the service's `EnvironmentFile`. The
`LINEAR_API_KEY` / `GITHUB_TOKEN` slots are consumed by trigger-path
preflight later; nothing reads them yet.

The built server must run against the Postgres World
(`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, as the env file sets):
at `workflow@4.8.4` the filesystem World fails to start from the production
bundle (`Invalid version string: "bundled"`). It still works under
`nitro dev` for scratch use.

## 4. Run history (`workflow web`)

```sh
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5439/jigs \
  pnpm --filter @jigs/service exec workflow web --backend @workflow/world-postgres
```

Serves the SDK's observability UI (default `http://localhost:3456`) reading
the same World the service writes — run history, step attempts, events.

## 5. Crash-model repro

Scripted (requires steps 1–2; stop anything on port 8992 first):

```sh
cd packages/service
node scripts/crash-repro.mjs suspension
node scripts/crash-repro.mjs midstep
```

- `suspension` proves memoized replay: trigger the `demo-crash` pipeline,
  let its slow step finish, SIGKILL the service while the run is suspended
  at its approval hook, restart, resume — the run completes and the final
  result carries the step's pre-kill marker verbatim, with no second
  `[slowStep] START` ever logged.
- `midstep` proves startup rescue: SIGKILL while the slow step is in
  flight, restart — the World logs `Re-enqueued 1 active run(s) on
  startup`, the step re-runs from zero with a fresh marker, and the run
  completes with that second marker.

Manual equivalent against the systemd unit: trigger with
`POST /api/pipelines/demo-crash/runs` body `{"inputs":{"stepSeconds":60}}`,
watch `journalctl --user -fu jigs-service` for the `[slowStep]` lines,
`systemctl --user kill -s KILL jigs-service`, `systemctl --user start
jigs-service`, then `POST /api/hooks/resume` with the trigger response's
`resumeToken` and body `{"token":"…","payload":{"approved":true}}`, and
confirm completion via `GET /api/runs/<runId>`.
