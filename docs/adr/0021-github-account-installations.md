# GitHub credentials follow the binding's account

A factory may bind repositories across accounts, each of which has its own
GitHub App installation. App identities explicitly map account logins to
installation IDs; the remote's owner selects an entry case-insensitively.
Multiple Apps use the same lookup through a normalized identity list, with
exclusive account ownership. Explicit configuration makes a missing installation
an actionable preflight failure without needing discovery credentials or an API
request to decide which App should authenticate.

The existing `installationId` shorthand remains a wildcard for all bindings,
by explicit compatibility requirement for this feature. This is an exception
to the repository's usual no-compatibility policy: upgrading a published factory
must not force a config edit. It is only available in `github.identity`; entries
in `github.identities` require account maps so selection cannot be ambiguous.
Tokens are cached by App and installation together; the selected App also owns
PR operator attribution and optional co-author credit. Merge policy stays
explicit factory configuration.
