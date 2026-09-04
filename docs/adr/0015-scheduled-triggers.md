# The clock lives in the service, and a fire is an ordinary trigger

A factory declares recurring **schedules** in its `jigs.config.ts` — a name
mapped to a pipeline, a five-field cron, and the static inputs to fire it
with — and its own service is what keeps time. On start it creates one
[croner](https://croner.56k.guru/) job per valid schedule, and each tick goes
through the same trigger function `POST /api/pipelines/:name/runs` calls: the
pipeline's zod `inputs` are parsed, the `requires` manifest is preflighted
([ADR 0010](./0010-preflight-in-trigger-path.md)), a `ticket` input still
resolves to its Linear issue, and what comes out is a run indistinguishable
from `jigs run` except for its `triggerId` —
`schedule:<name>:<tick, ISO seconds, UTC>`, which is what the `trigger` column
in `jigs ps` reads. Decided in
[AGE-328](https://linear.app/salboogie/issue/AGE-328).

The declaration is a top-level map keyed by schedule name rather than
something nested under a pipeline: the name is what the startup log, the
`GET /api/schedules` listing and the `schedule.<name>` doctor check all refer
to, and one pipeline can carry several schedules with different inputs.

## Consequences

- **Declared in `jigs.config.ts`, not `jigs.yml`.** The inputs are typed
  against the pipeline's own schema, so a wrong field is a compile error in the
  factory and a validated failure at startup; in `jigs.yml` it would be a
  string map nobody type-checks. It also means no CLI verbs: `jigs.yml` is
  what `jigs bind` edits, and a schedule needs no editing verb because the
  pipelines beside it are already hand-written source.
- **A missed tick is skipped, not caught up.** croner computes each next
  occurrence from now, so a service that was down over a tick simply fires
  next time. A catch-up policy would have to decide how stale a fire may be,
  and nothing here has an answer that is right for both a nightly sweep and a
  weekly report.
- **Overlap is prevented by looking for an active run, not by a claim.** Before
  firing, the ticker lists runs and refuses if a non-terminal one carries this
  schedule's `triggerId` prefix, logging the run it is waiting on. The ticket
  proposed a claim token minted per schedule, which is the same guarantee for
  one service — a service per factory owns its schedules
  ([ADR 0012](./0012-per-factory-service.md)) — while dragging the suspension
  machinery into a pipeline that never asked for it. The run listing is
  already the index: it is what `jigs ps` reads, and a run's own status is
  what decides.
- **Preflight runs on every fire, and a failure is a log line.** There is no
  terminal to report to, so the formatted failures go to `jigs logs` under the
  schedule's name and no run is created — the same repair text a refused
  `jigs run` prints.
- **A malformed schedule costs its own tick and nothing else.** A name
  carrying a `:` (which would answer for another schedule's runs), an unknown
  pipeline, a cron croner rejects, or inputs the schema rejects are logged
  with their repair at startup and left unscheduled; the service starts, the
  other schedules run, and `jigs doctor` reports the same failures on demand
  through the check catalog.
- **No timezone field.** The cron is evaluated in the service host's local
  time, the way a crontab on that host would be. A factory's service and its
  operator are on the same machine today; the field can be added the day they
  are not.

## Considered options

- **A durable scheduler run** — one long-lived workflow that sleeps to the next
  occurrence and starts the real run on waking. Rejected: it makes the clock a
  memoized replay of `sleep()` calls, so changing a cron means orphaning or
  cancelling the run that holds the old one, and every service restart is a
  replay of a run whose only job was to wait. A cron string in a config file is
  the thing an operator edits; a parked run is not.
- **One-shot timestamps** (fire once at a named instant) and **a reminder
  pipeline** to hang them on — both in the ticket, both deferred: nothing
  consumes them yet, and a one-shot's real question is what happens to a fire
  whose instant passed while the service was down, which is the catch-up
  policy this ADR does not have. A one-shot is also expressible as a cron
  today, at the cost of firing again next year.
