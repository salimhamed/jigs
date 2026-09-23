# Review loop over a webhook ingress with resource-scoped hook tokens

The GitHub review leg (and the Linear needs-human wake with it) runs
webhook-first: the Workflow SDK service exposes static ingress routes
(`/ingress/github`, `/ingress/linear`) that verify the provider's HMAC
signature, reconstruct a hook token from the payload, and call
`resumeHook(token, typedPayload)`. A verified
delivery with no listening run is acknowledged with 200 and dropped; a 404 is
reserved for a matching run whose resume failed. The ingress is stateless: no
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

**Wakes are hints, never truth.** On every wake — webhook delivery, the
five-minute nudge, manual `jigs poke <run>`, or startup reconciliation — the
gate fetches actual state from the provider API and re-derives what is
outstanding; a wake with nothing outstanding re-suspends. Webhooks are purely a
latency optimization over an always-correct core, which also derisks the tunnel
and both providers' weak retry policies (Linear disables persistently failing
webhooks outright).

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
- Linear: one workspace-wide webhook per factory
  (`resourceTypes: ["Comment"]`), manually pointed at that factory's exact
  `<ingressUrl>/ingress/linear`; secret into service config. `jigs doctor`
  verifies that exact webhook exists and remains enabled. Webhooks at the same
  path on other hosts belong to other factories or are stale and do not count.

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

### Addendum: exact-URL ownership (2026-09-09)

Each factory owns the repository hook at its exact ingress URL. Hook discovery
formerly matched only `/ingress/github`, but that let one teammate's factory
overwrite another's hook and secret when both used the same repository. A
hostname change now creates a new hook; the old hook is left for manual
deletion rather than repaired across hostnames.

### Addendum: commit-status routing (2026-09-16)

Repository hooks now subscribe to GitHub's legacy `status` event as well as
`check_suite`, so CodeBuild results wake a gate immediately. It was originally
excluded because its payload names a commit but no pull request. The service
ingress now resolves that sha through `GET /repos/{owner}/{repo}/commits/{sha}/pulls`
and wakes every open pull request whose head matches; the network lookup stays
outside the replay-safe blocks layer.

- AGE-393 amends the original delivery response: verified events with no
  matching suspended run return 200 with `{ delivered: false }`, because they
  are successfully received events jigs does not care about. Resume failures
  remain 404 so providers still record genuine delivery failures.
- AGE-393 also amends the original single-Linear-webhook onboarding model:
  Linear webhooks are workspace-wide, but each self-hosted factory needs its
   own exact ingress URL. Doctor diagnoses a missing or disabled exact match and
   reports other `/ingress/linear` hosts only as possible stale configuration.

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
- AGE-398 widens what counts as review feedback. A factory running on its
  operator's own token shares that GitHub identity, and GitHub refuses approve
  and request-changes on one's own pull request — so the formal review states
  the loop was built around are unreachable on exactly the pull requests jigs
  opens. A `COMMENTED` review's body and a comment on the pull request
  conversation (`issue_comment`, now in the repo hook's event set) are
  therefore wakes in their own right, carried as synthetic single-comment
  threads and answered on the conversation. The self guard extends with them:
  jigs' own conversation comments are filtered by the ids it posted, in their
  own id space, never by author login — the same collision the inline guard
  already avoids.
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

### Addendum: pull request progress lives on GitHub (2026-09-15)

AGE-403 and AGE-407. Two problems had one answer. A run that attended a pull
request kept what it had already seen in a variable inside the paused workflow,
so a replacement run started blank and answered jigs' own earlier comments as
if they were review feedback. And a webhook GitHub failed to deliver was never
delivered again, so a parked run waited for a human to run `jigs poke`.

**Every comment jigs posts carries a hidden marker.** It is an HTML comment:
GitHub renders nothing, a reader sees nothing, and the API returns it.

```
<!-- jigs:v1 {"scope":"shipWorkflow/AGE-123","run":"wrun_01M2E…","kind":"reply","source":"5657161233@2026-09-14T01:17:07Z"} -->
```

The payload is JSON, so quoting and escaping are `JSON.stringify`'s problem
rather than a format of our own. One sequence still matters: `-->` ends an HTML
comment wherever it appears, so rendering refuses any value carrying it, and
the scope — the only value a caller supplies — is checked where it enters. A
field this version does not know is ignored rather than refused.

- `scope` is the continuation identity. It survives run replacement, and it is
  what "my work" means. It defaults to the workflow function's own name plus
  the ticket key — the name a person wrote, taken from the end of the durable
  address the compiler stamps, so moving a workflow file does not orphan the
  markers on a parked pull request. Renaming the function does change the
  scope, exactly as it moves the durable step ids
  (`e2e/expected-ids.txt` states that rule). Any caller may pass its own scope
  instead, and a bespoke workflow reviewing someone else's pull request should.
- `run` is provenance for a reader. Nothing matches on it.
- `kind` is `reply` (answers the thing named by `source`), `completion` (work
  finished for it, written only once the effect succeeded) or `status` (a note
  about a commit). A `status` marker also carries `reason`, `merge` or `ci`,
  because "I could not merge this commit" says nothing about that commit's
  checks and must not silence them.
- `source` names what is answered: a comment as `id@updatedAt`, or a commit.
  A reply that answers nothing nameable still carries a sourceless marker: an
  unmarked comment of jigs' own would read as a reviewer's next time.

Markers are read off unquoted lines only. GitHub's "Quote reply" copies the
whole body, marker included, as `> ` lines, and a human quoting jigs' answer to
ask a follow-up is a human asking a follow-up.

**Classification is a pure function of the snapshot and the scope.** There is
no cursor. A human comment is outstanding unless a comment on the pull request
carries a marker of this scope, of kind `reply` or `completion`, naming that
comment's id *and* its edit time — so editing a comment asks the question
again. A comment carrying any marker at all, of any scope, is jigs' own: this
replaces both the author check and the id ledger, and works whether jigs runs
as a bot or as its operator. Per wake:

| Wake | Outstanding while | Evidence that finishes it |
| --- | --- | --- |
| `review-comments` | a human comment or review body has no marked answer | a `reply` or `completion` marker naming that comment version |
| `ci-red` | the current head is red | the branch moves past that commit, or a `status` marker with `reason="ci"` naming it |
| `merge-ready` | approved, green, nothing outstanding, not merged | the pull request merges, or a `status` marker with `reason="merge"` naming that commit |
| `closed` | — | terminal |

The property this buys, pinned by test: the same snapshot delivered twice costs
no second agent turn, reply or merge attempt. `ci-green` and `approved` wakes
are gone with the cursor — neither is derivable from a snapshot alone, and
neither had a consumer.

**Post-once.** jigs posts each answer at most once, and the reason is the
snapshot at the top of every wake: the classifier has already seen which
comments carry an answer of this scope and yields only what is outstanding.
There is no second check before posting — nothing is re-read, nothing is
compared. That is also why the two POST steps the factory wraps are
single-attempt (`maxRetries = 0`): jigs never retries a write it cannot tell
apart from a success. A post whose response is lost ends that wake quietly,
without failing the run; the next wake — a webhook, or the five-minute nudge at
worst — reads the pull request again and either finds the marker, in which case
the answer was delivered and nothing is owed, or does not, in which case it
posts. A reply lost to a transport failure is delayed by at most one nudge
interval, never dropped and never doubled.

**The hook is the fast path; a five-minute nudge is the floor.** The service
resumes every held `github:pr:` hook every five minutes, minus up to thirty
seconds of jitter, through the same `resumeHook` path the ingress uses, and
once more at startup — the reconciliation this ADR left as a fast-follow. Each
wake refreshes the whole snapshot; there is no cheap change probe, because
`updated_at` and comment counts miss exactly the CI change and the dismissed
approval that motivated the work. A run that is mid-turn is skipped:
`resumeHook` at `@workflow/core` 4.8.4 neither coalesces nor drops a resume, so
each call appends a `hook_received` event and queues a replay whether or not
anybody is waiting.

**Single writer, free readers.** The exclusive `github:pr:` subscription is
unchanged and remains the writer claim: a second run that tries to take it
fails. A scheduled read-only workflow registers no hook — it calls the snapshot
step on its own schedule — and uses its own scope, so it sees jigs' delivery
comments as nobody's feedback and none of them as its own completed work.

**The cost we accepted: replay grows while a run is parked.** Every nudge
appends a `hook_received` event and every wake records a snapshot step, and a
run replays its whole log each turn. A pull request open for days under
`merge.by: "human"` therefore does quadratic work for as long as it waits — a few
hundred events, which is slow rather than broken, and the price of never
losing a delivery. Backing the sweep off for a run that has been parked through
many unchanged sweeps is the obvious follow-up; it is not built here.

**Cutover.** Comments jigs posted before markers existed carry none, so a run
attending such a pull request reads them as human feedback once. Factories
upgrade with no parked runs, which is already the rule, and nothing is
engineered around the old comments.

### Addendum: webhooks are optional (2026-09-23)

Polling is now the main path and webhooks only make it faster. A factory that
never exposes a public URL is a supported setup, not a half-configured one.
This follows from "wakes are hints, never truth": a wake was already a request
to re-read the provider, so a timer can supply it as well as a delivery.

- `ingressUrl` is replaced by an optional `webhooks` block with a required
  `url` and a required `enabled` per provider (`github`, `linear`). There is no
  master switch and nothing is inferred from a secret being present. Without
  the block both providers are off.
- A provider that is off has no `/ingress/<provider>` route. A provider that is
  on without its secret (`GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`)
  stops the service at boot, naming the variable, rather than answering every
  delivery with an error while its runs quietly fall back to polling.
- The nudge runs whatever the webhook settings are, with a separate timer per
  provider set by `service.pollIntervalSeconds.github` and `.linear` (default
  300, minimum 30). The jitter is up to a tenth of the interval, taken off,
  instead of a fixed thirty seconds.
- The nudge now also wakes `linear:ticket:` claims, but only for a run that
  also holds a `jigs:needs-human:` marker for that ticket. The claim is held
  for the run's whole life, so waking it while the run waits on something else
  would add a replay and a stale hint on every sweep. `haltForHuman` already
  re-read the comment thread from Linear on every wake and never read the
  payload, so a payload-less wake needed no change there.
- `jigs bind` skips the repo webhook while GitHub webhooks are off and says PR
  waits are polled. Doctor checks a provider's webhook, and its secret, only
  when that provider is on, and an App needs "Repository webhooks: read &
  write" only then. The Linear webhook is still created by hand.

The replay cost recorded above now applies to every parked run rather than
only to those whose deliveries were lost, and a slower interval is the
operator's lever against it.
