# Resource-scoped hook tokens; webhooks are hints over polling

Status: accepted

A run that waits on GitHub or Linear holds a Workflow SDK hook whose token names
the external resource, not the run: `github:pr:<owner>/<repo>#<number>` for a
pull request, `linear:ticket:<issue-uuid>` for a ticket (the UUID, because
Linear comment payloads carry it). The SDK's one-token-per-backend namespace is
the exclusivity lock: a second run that tries to take a token fails naming the
owner, and `jigs cancel` frees a zombie. A run claims its ticket token as its
first act and holds it for its whole life, and that claim doubles as the
needs-human wake channel.

**Wakes are hints, never truth.** On every wake (webhook, poll, `jigs poke`,
startup) the gate re-reads the provider and derives what is outstanding; a wake
with nothing outstanding re-suspends. Polling is the main path. The service
nudges every held `github:pr:` hook, and every `linear:ticket:` claim whose run
also holds a `jigs:needs-human:` marker, on a timer per provider
(`service.pollIntervalSeconds`, default 300, minimum 30, minus up to a tenth of
jitter) and once at startup. Webhooks, when enabled, only make it faster.

**Progress lives on the pull request.** Every comment jigs posts carries a
hidden `<!-- jigs:v1 {...} -->` marker with a `scope` (default: the workflow
function name plus its subject, such as the ticket key), `run`, `kind`
(`reply`, `completion`, `status`) and `source` (the comment `id@updatedAt` or
commit it answers). Classification is a pure function of the snapshot and the
scope; there is no cursor. A human comment is outstanding until a marker of
this scope answers that exact comment version, and any marked comment is jigs'
own. Markers on quoted lines are ignored.

## Consequences

- The ingress (`/ingress/github`, `/ingress/linear`) is stateless: it verifies
  the HMAC signature, rebuilds the token from the payload and calls
  `resumeHook`. A verified event with no listening run returns 200 with
  `{ delivered: false }`; a failed resume returns 404 so providers record it.
  A `status` event is resolved to its open pull requests through the GitHub
  API before waking them.
- A provider's route exists only when `webhooks.<provider>.enabled` is true,
  and an enabled provider without its secret stops the service at boot.
  `jigs bind` manages the repository hook at the factory's exact URL; the
  Linear webhook is created by hand, and doctor checks it only when enabled.
- **Post once.** The factory's POST wrappers have `maxRetries = 0`. A post whose
  response is lost ends the wake quietly; the next wake finds the marker or
  posts again. A reply is delayed by at most one poll, never doubled.
- The gate ends only when the pull request closes. An approval is a wake like
  any other; whether it means merge now is the consumer's policy
  (`merge.by` defaults to `"human"`).
- A read-only workflow registers no hook and uses its own scope, so it never
  mistakes jigs' delivery comments for its own work.
- Replay grows while a run is parked: each nudge appends a `hook_received`
  event. A slower poll interval is the operator's lever.
- Renaming a workflow function changes its default scope, just as it moves the
  durable step ids.
