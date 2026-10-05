# Event triggers start runs; wakes stay separate

Status: accepted; delivery kinds and the poll superseded by [0015](./0015-hub.md), where every occurrence arrives as a provider event through the hub

A run used to start only from `jigs run` or a schedule, and provider events
could only wake a run that already existed ([0003](./0003-webhook-ingress-resource-scoped-tokens.md)).
An **event trigger** starts a run per occurrence from a provider. It is declared by
name under `triggers` in `jigs.config.ts`, next to `schedules`, with a
workflow, a source, optional fixed `inputs` and a `maxActive` cap that
defaults to 3. A source takes the provider's own query parameters under the
provider's own names, such as `pagerduty.incidents({ service_ids, urgencies })`
or `slack.messages({ channels })`. jigs adds no filter language of its own, and
finer judgement happens inside the run.

Starting a run has to be exact in a way a wake does not. A wake is a hint the
gate re-derives. Starting twice is a second agent working the same page. So
every occurrence gets a row in a `jigs_triggers` table, keyed by trigger name
and occurrence. The row is written `pending`, the run is started through the
ordinary trigger path, and then the row is marked `started`. Startup starts any
leftover `pending` row. After a crash, startup finds the run by its occurrence
attribute and adopts it. An uncertain start is never retried: if its run isn't
found, the occurrence is recorded `failed` for the operator, so a trigger never
starts a second run for an occurrence.

- **The source defines an occurrence, and jigs enforces it.** A workflow
  cannot, because the decision comes before any run exists. A PagerDuty
  occurrence is an incident id from `incident.triggered`, at most one run per
  incident, ever. A Slack occurrence is a top-level message, `channel` + `ts`.
- **The run's inputs are a reference, never a payload**: `{ incident }` or
  `{ channel, ts }`, merged with the trigger's fixed inputs. The run reads its
  own snapshot. A polled event and a pushed one therefore start identical runs.
- **Every delivery kind lands on the same path.** A source always polls, on its
  provider's `service.pollIntervalSeconds` interval, and may add push kinds: a
  webhook through the ingress, or a socket for providers that offer one. Push
  only makes a start sooner, as in 0003.

## Consequences

- Two triggers matching one event start two runs, one each.
- A new trigger starts from now. After downtime it catches up only within a
  per-trigger lookback window, about an hour by default, and older
  occurrences are recorded `skipped`, so switching a trigger on never floods
  the factory.
- A start that fails validation or preflight is recorded `failed` with its
  check report, is not retried, and leaves nothing on the provider. `jigs
  status` and `jigs doctor` show it with its repair.
- Past `maxActive`, occurrences wait as `pending` and start oldest first as
  runs finish.
- A Slack source skips messages from the factory's own bot. That is an
  intended exception to identifying jigs' own posts by id rather than author
  ([0009](./0009-factory-identity-per-provider.md)). It holds because each
  factory has its own Slack app, which only ever acts as itself; posting as a
  person would need a table of posted ids instead.
- The Slack source uses polling plus Socket Mode, with no Events API: Socket
  Mode needs no public URL, and polling covers what Slack drops after about
  6 minutes.
- Wakes on resources a triggered run holds (`pagerduty:incident:<id>`,
  `slack:thread:<channel>:<ts>`) use the ordinary hook path, not this one.
- Rejected: one event router that both starts and wakes (it would put the exact
  start path and the forgiving wake path in one place); a jigs filter syntax or
  a factory `match()` function (a new kind of service-side factory code before
  a case needs it); markers on the provider as the dedupe record (a run that
  decides to do nothing should leave no trace); passing payloads as inputs
  (polled and pushed events would differ).
