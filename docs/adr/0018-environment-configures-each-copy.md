# The environment configures each running copy

Status: accepted

The hub ([0015](./0015-hub.md)) made a second checkout of a factory unsafe. A
git worktree with the same hub token shared one cursor, so each copy got some
events and both started runs; a separate hub factory fixed the cursor, but its
copy of `jigs.config.ts` still armed every production trigger. `jigs init`
committed path-derived ports and a compose project, so every worktree collided
with the main checkout. The hub was required even by factories that used no
provider. And the environment had two sources that disagreed: `ctx.env()`
preferred the shell and re-read `.env`, while the service child got `.env`
laid over the shell.

The principle: **`jigs.config.ts` says what the factory is; the environment
says how this running copy is set up**: its ports, compose project, database,
hub token, and which triggers and schedules are live, with their per-copy
values. A copy is one checkout running its own service.

1. **The factory loads its own environment, in its config.** The scaffolded
   `jigs.config.ts` calls Node's `process.loadEnvFile` on `.env.local`, then
   `.env`, each only if present. A value already set is never replaced, so the
   order is shell, `.env.local`, `.env`. Authors may use dotenv, mise, direnv,
   `op run` or anything else. jigs has no `.env` code.
2. **Every command except `init` chdirs to the factory root and loads the
   config first.** A broken config stops every command; accepted.
3. **The service inherits `process.env` from the CLI that starts it**, plus
   only what jigs derives (`PORT`, `WORKFLOW_LOCAL_BASE_URL`, the Postgres
   World's managed-shutdown flag).
4. **No jigs `env()` helper.** Authors write `process.env.X`. Schema
   validation reports a missing value by field, not by variable; accepted.
5. **Ports and the compose project live only in the environment**:
   `JIGS_SERVICE_PORT`, `JIGS_DASHBOARD_PORT`, `COMPOSE_PROJECT_NAME`,
   `JIGS_POSTGRES_PORT`. `service` left the config schema.
6. **Every trigger and schedule has a required `active: boolean`.** The
   documented form is `active: process.env.X_ACTIVE === "true"`, so a fresh
   copy is quiet. An inactive trigger is not armed or checked, its queued
   occurrences are withdrawn at start, and an inactive schedule never fires.
7. **The hub is optional and checked when used.** `hub` and `JIGS_HUB_TOKEN`
   are both optional; a copy is connected only with both. An unconnected copy
   starts, its doctor runs no hub or provider checks, and a run that needs a
   provider fails preflight.
8. **Shared and per-copy files, by convention.** `.env` holds values every
   copy shares and is what a worktree copies; `.env.local` holds this copy's
   and is never copied. `jigs init` writes `.env.example` and
   `.env.local.example`, the second filled with its suggested ports. A slot
   with no value is commented out, because an empty `X=` would hide the value
   from a file loaded after it.
9. **Error-message niceties go.** Code that only made an error more specific,
   such as "set X in `.env`" provenance and a factory-name headline, was
   deleted.
10. **A missing port variable fails startup**, naming it. No defaults, no
    derived ports.
11. **An active trigger, or an active schedule whose workflow needs a
    provider, fails startup in a copy with no hub connection.** Inactive ones
    never need the hub.
12. **`jigs hub connect` is deleted.** The hub's factory page shows the config
    line and the environment line to copy.
13. **In a copy with no hub connection, doctor runs no hub-dependent checks.**
    Startup already refuses active triggers and schedules that need the hub,
    and running a workflow that needs a provider fails its preflight plainly;
    a quiet copy's doctor stays clean.

## Consequences

- The development pattern is recorded in [0015](./0015-hub.md).
- A deployed copy sets its variables through its platform (task definitions,
  a secrets manager) and needs no file.
- The environment loads once per process and a set value wins, so tests that
  load two factories in one process stub the environment or use separate
  processes.
- Rejected: a jigs `env()` helper (a second way to read what `process.env`
  already gives); a `JIGS_TRIGGERS` allowlist (one variable naming config keys,
  out of sight of the trigger it governs); `roles` on triggers (a vocabulary
  for what one boolean per trigger says); jigs loading `.env` itself (it is the
  two-source disagreement again, and locks out other loaders); sandbox apps
  per engineer (every provider app made twice, and dev never sees real
  events); resending events from the hub to a copy (not needed once `active` keeps
  copies apart).
