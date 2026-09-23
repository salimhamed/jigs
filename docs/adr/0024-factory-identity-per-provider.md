---
status: proposed
---

# A factory has its own identity on each provider

Proposed on 2026-09-23.

A factory acts on GitHub and on Linear. When it acts with the operator's
personal credential, the operator and the factory become the same account,
and that collides on both providers. On GitHub the operator cannot approve a
pull request jigs opened, because GitHub refuses self-approval. On Linear a
run that parks for a human @-mentions the operator, but Linear sends no
notification for your own comments, so the parked run sits silent until
someone happens to look. Threads on both also read as the operator talking to
themself.

So each provider gets an identity setting with the same shape: one mode where
jigs is a person's credential, and one where jigs is an app acting as itself.

## GitHub: ratify the shipped union

`github.identities` is a list of `{ mode: "pat" }` or
`{ mode: "app", appId, installations, privateKeyPath, operator, coAuthor? }`.
`pat` means jigs is you; `app` means jigs is a bot. This records the shape
already in use. The earlier decision that the credential follows the
binding's account stands unchanged.

## Linear: one identity, `key` or `app`

`linear.identity` is `{ mode: "key" }` or `{ mode: "app" }`.

- `key` is any user's personal API key: the operator's, or a dedicated user
  created for the factory.
- `app` is a Linear OAuth application acting as itself (`actor=app`). The
  factory mints a token with the `client_credentials` grant from the client
  id and secret: no browser flow, no redirect. The token is valid for 30 days
  and is re-minted on a 401. It is cached in memory, once per service
  process, and never written to disk.
- The app is owned by the workspace the factory serves. A factory serving
  another workspace registers its own app.

A factory has exactly one Linear identity, unlike GitHub's list. GitHub needs
a list because bindings span accounts, each with its own installation. jigs
has no notion of a Linear workspace: issue identifiers such as `ABC-1` can
collide across workspaces, a run's ticket attribute holds the raw reference,
and there is one Linear webhook secret. Several workspaces per factory would
need all of that first. A factory never holds two Linear credentials.

## Secrets live in `.env`, config carries only the mode

Every provider secret lives in the factory's `.env`: `GITHUB_TOKEN` for a PAT,
the App's private key at the path config names, `LINEAR_API_KEY` for `key`
mode, and `LINEAR_CLIENT_ID` plus `LINEAR_CLIENT_SECRET` for `app` mode.
`jigs.config.ts` says only which mode is in use. `LINEAR_API_KEY` is read from
the service's environment today; moving it to the factory `.env` is a
breaking change, made in place.

## Comments post under the plain app name

jigs does not use Linear's `createAsUser` label to post as, say,
"the operator (via jigs)". Linear's agent guidelines say software must never be
mistakable for a person, and a borrowed display name brings back exactly the
ambiguity the separate identity removes.

## Reply detection does not depend on identity

A parked run recognises a human's reply by excluding every comment it has
posted on the ticket, by comment id. Today it excludes only its halt comment,
so a later note from jigs on the same ticket would wake it. Keying on the
run's own comment ids works the same in both modes and needs no lookup of who
jigs is. The workflow API decision is corrected to match.

## Doctor in `app` mode

Listing Linear webhooks needs the `admin` scope, and Linear refuses to grant
`admin` to an app actor. In `app` mode `jigs doctor` skips the webhook-listing
check, says why, and asks the operator to confirm the webhook by hand. Holding
a second, admin-capable credential just for this check was rejected.

## Evidence

Verified live on 2026-09-23 against an app-actor token minted with client
credentials:

- A comment posted by the app that @-mentioned the operator produced an inbox
  notification.
- Every Linear call jigs makes worked: reading an issue by identifier,
  `issueCreate`, `commentCreate`, `issueUpdate` with a `stateId`, the snapshot
  query and the projects query.
- The `webhooks` query was refused with "admin required".

## Considered and rejected

- **Notify out of band when a run parks** (Slack, ntfy, a webhook). With a
  distinct identity, Linear's own inbox is the notification, and a second
  channel is one more thing to configure and keep working.
- **Several Linear identities per factory**, mirroring GitHub. See above:
  nothing in jigs can tell workspaces apart yet.

## Consequences

- Re-minting a client-credentials token with a different scope set revokes
  every live token for that app. A jigs release that changes the scopes it
  requests will make running factories hit one 401; the re-mint path
  recovers from it.
- The Linear Agents platform (an app people can mention and assign, with
  agent sessions) is out of scope and left to a follow-up decision. This app
  registration is its prerequisite, and client-credentials tokens were shown
  to carry `app:mentionable` and `app:assignable`.
