# Deploying the jigs service

> Superseded by `jigs service start|stop|restart|status|logs`, which supervises
> a service per factory repo. The systemd unit below is the single global
> service and is kept only until that cutover finishes.

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
`LINEAR_API_KEY` / `GITHUB_TOKEN` slots are consumed by the suspension
primitives (`needsHuman()` posts Linear comments, `pullRequestGate()`
re-checks PR state), and both are validated on every trigger: preflight
refuses to create a run when a requirement is unmet, reporting every failure
with its repair. `jigs doctor` runs the same checks without a launch.

The built server must run against the Postgres World
(`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, as the env file sets):
at `workflow@4.8.4` the filesystem World fails to start from the production
bundle (`Invalid version string: "bundled"`). It still works under
`nitro dev` for scratch use.

## 4. Webhook ingress

The service's `/ingress/github` and `/ingress/linear` routes receive provider
webhooks: signature-verified, stateless, and safe to miss — every wake is
re-checked against the provider, and `jigs poke <run>` (below) covers any
delivery that never arrived.

### Tunnel (one-time, manual)

The ingress must be reachable from the public internet. tailscale funnel is
the default:

```sh
tailscale funnel --bg 8990
```

The printed `https://<machine>.<tailnet>.ts.net` URL is your ingress URL.
Alternative: `cloudflared tunnel --url http://localhost:8990` (or a named
cloudflare tunnel for a stable hostname).

### GitHub (per target repo)

Put the ingress URL in the factory repo's `jigs.yml`:

```yaml
ingress_url: https://<machine>.<tailnet>.ts.net
```

then (re-)bind each target repo with `GITHUB_TOKEN` set — `jigs bind`
creates the repo webhook, verifies it on later binds, and repairs drift. The
signing secret is generated once into
`~/.local/share/jigs/github-webhook-secret`; the service reads the same file.

Manual alternative: one org-level webhook (org settings → Webhooks) pointed
at `<ingress_url>/ingress/github`, content type `application/json`, events
`pull_request`, `pull_request_review`, `pull_request_review_comment` and
`check_suite`, secret from that same file — covers every repo without
per-repo binds.

### Linear (one-time, org-level)

Create one webhook in Linear (Settings → API → Webhooks) pointed at
`<ingress_url>/ingress/linear` with resource types `Comment` only. Put its
signing secret in `~/.config/jigs/service.env` as `LINEAR_WEBHOOK_SECRET`
and restart the service.

### Missed deliveries

```sh
jigs poke <runId>
```

manually wakes a suspended run over the same code path as a webhook delivery
(`--service <url>` or `JIGS_SERVICE_URL` if the service is not on
`http://localhost:8990`). Scripted end-to-end check (requires steps 1–2):
`cd packages/service && node scripts/poke-repro.mjs`.

## 5. Operating runs from the CLI

```sh
jigs run suspension-demo --input issueId=<uuid> --input askHuman=true
jigs ps
jigs logs <run>
jigs cancel <run> [--force]
```

Every verb takes `--service <url>` / `JIGS_SERVICE_URL`. `--input` values are
read as JSON with the raw string as the fallback, so `askHuman=true` is a
boolean and `AGE-123` is a string; a value the pipeline's `inputs` schema
rejects fails in the CLI, before any run is created.

`<run>` is a run id, a unique id prefix, or the ticket the run claimed — an
ambiguous prefix lists its candidates instead of guessing.

`jigs run` and `jigs logs` hand the log surface back to the SDK, printing
`npx workflow web --backend @workflow/world-postgres <run>`. The backend is
named by the service, not the CLI — `workflow web` otherwise inspects the
local world and finds nothing. Run it with `WORKFLOW_POSTGRES_URL` set in
your shell, as step 6 does.

`jigs cancel` is the escape hatch when a run holds a resource nobody is
coming back for: cancelling releases every hook it claimed, so the same
ticket can be launched again. A suspended run cancels silently — no process
is involved — while a run still in flight is confirmed first, and `--force`
skips that prompt when there is no terminal to answer it.

Scripted end-to-end check (requires steps 1–2, and `pnpm build`):
`cd packages/service && node scripts/cli-repro.mjs`.

## 6. Run history (`workflow web`)

```sh
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5439/jigs \
  pnpm --filter @jigs/service exec workflow web --backend @workflow/world-postgres
```

Serves the SDK's observability UI (default `http://localhost:3456`) reading
the same World the service writes — run history, step attempts, events.

## 7. Crash-model repro

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
