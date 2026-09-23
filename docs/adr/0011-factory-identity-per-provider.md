# A factory has its own identity on each provider

Status: accepted

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
  posted on the ticket, never by author, so detection works in both modes.
- In Linear app mode `jigs doctor` skips the webhook listing, because it needs
  the `admin` scope an app actor cannot hold, and asks the operator to confirm
  the webhook by hand. A second admin credential for this was rejected.
- Re-minting a client-credentials token with a different scope set revokes
  every live token for that app; a release that changes requested scopes costs
  running factories one 401, which the re-mint recovers from.
- Rejected: out-of-band notification of parked runs (Linear's inbox suffices
  once jigs has its own identity), and several Linear identities per factory.
