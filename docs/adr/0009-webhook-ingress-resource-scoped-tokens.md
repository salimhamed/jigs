# Review loop over a webhook ingress with resource-scoped hook tokens

The GitHub review leg (and the Linear needs-human wake with it) runs
webhook-first: the Workflow SDK service exposes static ingress routes
(`/ingress/github`, `/ingress/linear`) that verify the provider's HMAC
signature (plus Linear's timestamp replay guard), reconstruct a hook token
from the payload, and call `resumeHook(token, typedPayload)` — a 404 means no
run is listening, and the delivery is dropped. The ingress is stateless: no
mapping tables, no delivery log. Decided in
[AGE-293](https://linear.app/salboogie/issue/AGE-293/github-review-loop);
the ticket's resolution comment holds the full question-by-question record.

`createWebhook()` was rejected for this: it generates random tokens by design
(to protect public endpoints), while GitHub and Linear webhook configs are
static per repo/org. Custom-token `createHook()` + a jigs-owned ingress is the
SDK's documented pattern for exactly this case.

**Tokens name external resources, not runs.** The gate's token is the PR
(`github:pr:<owner>/<repo>#<number>`); the ticket's token is the Linear issue
(`linear:ticket:<issue-uuid>` — the UUID, because Linear Comment payloads
carry `issueId` as a UUID). This *supersedes ADR 0008's run-ULID token
scoping*: the SDK's global-token-namespace-per-backend, treated there as a
hazard, is used here as the enforcement mechanism. Owning the token means
being the one run allowed to listen; a second run's `getConflict()` resolves
with the owner and the new run hard-fails naming it (`jigs cancel <run>` is
the escape hatch for a zombie owner). A run claims `linear:ticket:<uuid>` as
its first act — one active run per ticket, failing in seconds instead of after
a paid implement step — and that claim hook, held for the run's whole life,
doubles as `needsHuman()`'s wake channel.

**Wakes are hints, never truth.** On every wake — webhook delivery, manual
`jigs poke <run>`, or startup reconciliation (a fast-follow if enumerating
suspended runs proves awkward) — the gate fetches actual state from the
provider API since a last-seen cursor and re-checks its satisfier; unsatisfied
wakes re-suspend. Webhooks are purely a latency optimization over an
always-correct core, which also derisks the tunnel and both providers' weak
retry policies (Linear disables persistently failing webhooks outright).

**`pullRequestGate()` is an async iterable**, not a call-per-wake await: one
hook per PR held across the whole review (`for await (const wake of gate)`),
exiting on approval or close. This maps one-to-one onto the SDK hook's
iterator surface and never releases the token mid-review.

The rest of the loop, recorded on the ticket: the builder answers review
comments as threaded replies (resume-first via persisted session pointers,
with a mandatory fresh-context fallback — Claude sessions expire at 30 days;
Codex resumes only on the app-server surface, validated by
[AGE-305](https://linear.app/salboogie/issue/AGE-305/codex-app-server-resume-prototype));
red CI on the PR head wakes the builder with a 3-consecutive-attempts bound;
escalation is a GitHub @mention on the same gate, never `needsHuman()`; jigs
squash-merges on approval by default (human-merges mode as config);
close-unmerged is a terminal failed run under ADR 0007's teardown matrix.

## Onboarding surface

- Tunnel: tailscale funnel is the blessed default (cloudflared documented as
  the alternative) — manual, one-time, outside jigs.
- GitHub: `jigs bind` creates/verifies the per-repo webhook idempotently
  (secret generated into the jigs data dir). Org-level webhooks are a
  documented manual alternative.
- Linear: one org-level webhook (`resourceTypes: ["Comment"]`), manual
  one-time setup like the tunnel; secret into service config.

## Considered options

- **`createWebhook()` per run**: rejected — random tokens can't be targeted
  by a static GitHub/Linear webhook config.
- **Run-ULID tokens + a PR→run mapping table** the ingress consults: honors
  ADR 0008 verbatim but costs a table, a write point, and a stateful ingress
  to deliver an exclusivity property the token namespace enforces for free.
- **External poller / polling gate**: strictly worse latency and standing API
  load once the ingress exists; survives as the poke/reconciliation fallback
  on the same code path.
- **Trusting webhook payloads**: rejected — the review-submitted payload
  doesn't carry usable inline-comment bodies anyway, so the since-cursor
  fetch must exist regardless; hint semantics make every delivery droppable.

## Consequences

- ADR 0008's "scope tokens by run ULID, never by ticket id alone" is
  superseded (amendment note there). The rule is now: *a token names the
  external thing being listened to; owning it is the exclusivity lock.*
- ADR 0004 gains an amendment: Codex agent steps that resume a session use
  the provider's app-server surface (`threadMode: 'persistent'`), validated
  by AGE-305. The stale-thread failure surfaces on codex 0.149.1 as a raw
  JSON-RPC `no rollout found for thread id` error rather than the provider's
  wrapped message, so the fresh-context fallback triggers on any resume
  failure, not on one error string.
- The Linear timestamp replay guard named above is dropped: the ingress now
  verifies the HMAC signature and nothing else, on both providers. Under "wakes
  are hints, never truth" a replayed Comment delivery only re-runs the
  satisfier, which re-suspends when the ticket has not moved, so the guard
  bought nothing GitHub's path did not already live without.
- This ADR's "exiting on approval or close" is amended: the gate now ends only
  when the pull request closes. `classifyPrState` sets `done` on
  `state === "closed"` and nothing else, because human-merges mode has to keep
  listening after an approval until a person presses merge. An approval is a
  wake like any other, and what it means — squash-merge now, or wait — is the
  consumer's policy; the review loop jig returns on it, and the suspension demo
  breaks its own loop.
- The fresh-context rebuild (brief + ticket snapshot + PR diff + comment
  threads) must stand alone as a first-class path, not a degraded one —
  session resume is an upgrade, never load-bearing.
- The service must be reachable from the public internet through the tunnel;
  every inbound route is signature-verified and the ingress holds no state
  worth attacking, but the tunnel is now standing infrastructure.
