# GitHub credentials follow the binding's account

A factory may bind repositories across accounts, each of which has its own
GitHub App installation. App identities explicitly map account logins to
installation IDs; the remote's owner selects an entry case-insensitively.
Multiple Apps use the same lookup through a normalized identity list, with
exclusive account ownership. Explicit configuration makes a missing installation
an actionable preflight failure without needing discovery credentials or an API
request to decide which App should authenticate.

`github.identities` is the only entry point: either one PAT entry, or one or
more App entries with explicit account maps. There is no singular identity sugar,
installation wildcard or compatibility path. This follows the repository's
no-compatibility policy; the two owned factories adopt the new shape when they
upgrade. Tokens are cached by App and installation together; the selected App
also owns PR operator attribution and optional co-author credit. Merge policy
stays explicit factory configuration.
