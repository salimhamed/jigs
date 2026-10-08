# A factory has its own identity on each provider

Status: accepted; superseded for GitHub, Linear, Slack and PagerDuty by [0015](./0015-hub.md); reading Linear comments superseded by [0017](./0017-ticket-runs-talk-in-their-linear-agent-session.md)

A factory now acts on GitHub only as the App its hub assigns it, with installation tokens the hub mints; the `pat` and `app` modes below are gone.

A factory now acts on Linear only as the Linear app its hub assigns it, with access tokens the hub refreshes; the `key` and `app` modes below are gone.

A factory now acts on Slack only as the Slack app its hub assigns it, with the bot token the hub hands out; `SLACK_BOT_TOKEN` and Socket Mode are gone.

A factory now acts on PagerDuty only as the PagerDuty app its hub assigns it, with tokens the hub mints; `PAGERDUTY_CLIENT_ID`, `PAGERDUTY_CLIENT_SECRET` and `pagerduty.identity` are gone, leaving only `pagerduty.from`.

A ticket run no longer reads ordinary Linear comments: it asks and is answered
in its own Linear agent session ([0017](./0017-ticket-runs-talk-in-their-linear-agent-session.md)),
so the comment-exclusion rule below is gone.

When a factory acts with its operator's personal credential, the two become one
account: GitHub refuses to let the operator approve a pull request jigs opened,
and Linear sends no notification for the operator's own @-mention of
themselves. So each provider has an identity setting with the same shape: jigs
as a person's credential, or jigs as an app acting as itself. Secrets live in
the factory's `.env`; `jigs.config.ts` says only which mode is in use.

**GitHub.** `github.identities` is either one `{ mode: "pat" }` entry
(`GITHUB_TOKEN`) or one or more `{ mode: "app", appId, installations,
privateKeyPath, operator, coAuthor? }` entries. `installations` maps account
logins to installation IDs; a binding's remote owner selects the entry,
matched case-insensitively, and each account belongs to exactly one App.
Explicit maps make a missing installation an actionable preflight failure with
no discovery call. The selected App also owns PR operator attribution and
optional co-author credit.

**Linear.** `linear.identity` is `{ mode: "key" }` (`LINEAR_API_KEY`, any
user's key) or `{ mode: "app" }` (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`).
In app mode the factory mints an `actor=app` token with the
`client_credentials` grant, caches it in memory per service process, never
writes it to disk and re-mints on a 401. A factory has exactly one Linear
identity: jigs cannot tell Linear workspaces apart.

## Consequences

- GitHub installation tokens are cached per App and installation together.
- Comments post under the plain app name; jigs never uses `createAsUser` to
  look like a person.
- A parked run recognises a human reply by excluding every comment id it has
  posted on the ticket, never by author, so detection works in both modes. It
  also skips every comment that belongs to a Linear agent session, since those
  are a conversation's ([0016](./0016-linear-agent-conversations.md)).
- In Linear app mode `jigs doctor` skips the webhook listing, because it needs
  the `admin` scope an app actor cannot hold, and asks the operator to confirm
  the webhook by hand. A second admin credential for this was rejected.
- Re-minting a client-credentials token with a different scope set revokes
  every live token for that app; a release that changes requested scopes costs
  running factories one 401, which the re-mint recovers from.
- Rejected: out-of-band notification of parked runs (Linear's inbox suffices
  once jigs has its own identity), and several Linear identities per factory.
