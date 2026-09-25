# Configuration

A factory is configured in two files. `jigs.config.ts` holds settings you
commit. `.env` holds secrets and is never committed. There is no other
configuration file.

After editing `jigs.config.ts`, run `jigs up`; it rebuilds and restarts the
service when needed. After editing `.env`, run `jigs service restart`, because
the service reads it when it starts.

```ts
import { defineFactory } from "@jigs-ai/jigs";

export default defineFactory({
  service: { port: 8990, dashboardPort: 9090 },
  bindings: {
    app: { remote: "git@github.com:owner/app.git" },
  },
  github: { identities: [{ mode: "pat" }], mergeApproval: "label" },
  linear: { identity: { mode: "key" } },
  workflows: {
    hello: () => import("./workflows/hello/hello.ts"),
  },
});
```

## `service`

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8990` | Where the service listens. The CLI talks to it here. |
| `dashboardPort` | required | Where the service hosts the run dashboard. |
| `pollIntervalSeconds.github` | `300` | How often waiting runs re-read their pull requests. Minimum 30. |
| `pollIntervalSeconds.linear` | `300` | How often runs waiting on a ticket reply re-read it. Minimum 30. |

`jigs init` picks ports for each factory so that two factories on one machine
rarely clash. The service and dashboard ports live here. The Postgres port
lives in `docker-compose.yml` and in `WORKFLOW_POSTGRES_URL` in `.env`; change
both together.

## `workflows`

A map from a workflow's name to a deferred import of its file. The name is what
`jigs run` takes. See [Build a workflow](/guide/build-a-workflow).

```ts
workflows: {
  triage: () => import("./workflows/triage.ts"),
},
```

## `bindings` {#bindings}

A binding names a target repository. jigs keeps its own clone of each one,
outside your checkout, and cuts every run's worktree from it. The service makes
the clones when it starts, so run `jigs up` after adding a binding.

```ts
bindings: {
  app: {
    remote: "git@github.com:owner/app.git",
    copy: [".env"],
    postCreate: ["pnpm install"],
    hookTimeoutMinutes: 20,
    mergeMethod: "rebase",
  },
},
```

| Key | Default | Meaning |
| --- | --- | --- |
| `remote` | required | The repository's Git remote URL. |
| `copy` | `[]` | Files to copy into each new worktree. |
| `postCreate` | `[]` | Commands to run in each new worktree, in order. The first failure stops provisioning. |
| `hookTimeoutMinutes` | `10` | The total time `postCreate` may take. |
| `mergeMethod` | `"squash"` | How jigs [merges](#merging) a pull request here: `"squash"`, `"merge"` or `"rebase"`. |

Each `copy` entry is a path, or a glob, inside `bindings/<name>/` in the
factory, and lands at the same path in the worktree. `bindings/app/.env`
arrives as `.env` at the worktree root. Keep secret files there; the
scaffold's `.gitignore` already ignores every `.env`. An entry that matches nothing fails the
worktree with a message naming it.

`jigs bind <remote>` adds a binding with its `remote`, and `jigs unbind <name>`
removes one; add the other keys by hand. Both commands edit a plain object
literal. If `bindings` is computed, they explain why and leave the file alone.

## `schedules` {#schedules}

Fire a workflow on a cron schedule:

```ts
schedules: {
  "monday-report": {
    workflow: "weekly-report",
    cron: "0 9 * * 1",
    inputs: { audience: "team" },
  },
},
```

`cron` has five fields, read in the service host's local time. Each tick is an
ordinary run: its inputs are checked and preflight runs. A tick is skipped while
the schedule's previous run is still active, and ticks missed while the service
was down are not made up. `jigs status` lists schedules under the runs, and runs
a schedule started show `schedule:<name>` as their trigger.

## `release` {#release}

What happens to a run's worktrees and scratch directory once it ends:

```ts
release: { onSuccess: "release", onFailure: "keep" },
```

That is the default. `onSuccess` applies to completed runs and `onFailure` to
failed and cancelled ones. A workflow's `defineWorkflow` can set its own `release`.
The service applies the policy when a run ends; waiting runs always keep everything.
A workflow that wants to release early, or needs the report, can call
`await release()` from `#jigs/steps`.

Release never throws away work: a worktree with uncommitted or unmerged changes
stays, and a branch is deleted only when its commits are proven merged. See
`jigs resources` in [CLI commands](/guide/cli) to inspect what is left.

## Merging {#merging}

Two settings say how a pull request is merged, and your workflow says who
merges it.

- **`github.mergeApproval`**: what counts as your consent. `"review"` is an
  approving review of the current commit; a new push withdraws it. `"label"`
  is the `jigs:approved` label on the pull request; it survives later pushes,
  so it means "merge whenever ready". The default follows the
  [identity](#github-identity): `"label"` with a PAT, `"review"` with an App.
  A PAT cannot use `"review"`: jigs opens pull requests as you, and GitHub does
  not let you approve your own.
- **`bindings.<name>.mergeMethod`**: `"squash"`, `"merge"` or `"rebase"`, as on
  GitHub. Default `"squash"`. With `squash` and `merge`, the pull request title
  becomes the commit title. With `rebase`, each commit is rewritten and loses
  its signature.

`jigs bind` creates the `jigs:approved` label on each GitHub repository it
binds, whichever approval you use.

Who merges is not configuration. The linear-ticket-to-pr recipe sets it with
`mergedBy` in its workflow file, and waits for you to merge by default. A custom
workflow decides in its own code and calls `mergePullRequest`, which applies
the two settings above, rereads GitHub and enforces readiness and approval
before it merges. `watchPullRequest` only reports facts and never
merges. None of this restricts an agent that merges through its own GitHub
tools.

jigs merges only when the approval is present, GitHub reports the pull request
mergeable, it is not a draft, and at least one check has run and passed.
**jigs never merges in a repository with no CI**: when no check has reported,
`jigs status` says so, since CI may not have started yet or the repository may
have none. While GitHub reports `behind`, `blocked` or `unknown`, jigs waits and
checks again later. A label cannot satisfy a branch rule that requires approving
reviews, so label approval only works on repositories without that rule. jigs
never changes branch protection.

## `agents.env` {#agents-env}

Agents do not inherit the service's environment. Each harness starts with a
base set: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, locale variables,
`TZ`, `TMPDIR`, the XDG directories, proxy settings and CA certificate
settings, plus the variables its own harness needs. Give agents anything else
by name:

```ts
agents: { env: ["SSH_AUTH_SOCK", "MISE_DATA_DIR"] },
```

The list holds names only; the values come from the service's environment when
an agent starts. Model keys such as `OPENROUTER_API_KEY` and variables jigs
sets itself cannot be listed; name a model key on its model source instead.
This limits what agents see in their environment only. They still run as your
user and can read any file you can.

## GitHub identity {#github-identity}

`github.identities` says who jigs is on GitHub. Choose the mode when you create
the factory, with `jigs init --github-identity-mode pat` (the default) or `app`.

### PAT: jigs acts as you

```ts
github: { identities: [{ mode: "pat" }] },
```

Put a personal access token in `.env` as `GITHUB_TOKEN`. Pull requests jigs
opens are authored by you, so GitHub will not let you approve them: jigs uses
[label approval](#merging). You can still send work back with review comments or a comment on the
pull request. A classic token needs `repo` (or `public_repo`), plus
`admin:repo_hook` if you turn on GitHub webhooks.

### App: jigs acts as a bot

```ts
github: {
  identities: [{
    mode: "app",
    appId: 123456,
    installations: { owner: 7654321 },
    privateKeyPath: "github-app.private-key.pem",
    operator: "your-github-login",
    coAuthor: "Your Name <you@example.com>",
  }],
},
```

Pull requests come from `<app-slug>[bot]`, and you review them like anyone
else's, so jigs uses [review approval](#merging) unless you choose the label. `jigs init --github-identity-mode app` takes all of these values as
flags. To set one up:

1. **Register a GitHub App** under Settings → Developer settings → GitHub Apps.
   Leave OAuth and device flow off, and turn its webhook off.
2. **Grant repository permissions**: Contents, Pull requests and Issues read
   and write; Metadata, Checks and Commit statuses read. Add Repository
   webhooks read and write if you turn on GitHub webhooks. `jigs doctor` names any that are missing.
3. **`appId`** is the App ID on its settings page.
4. **`privateKeyPath`** is the key GitHub generates under Private keys. Save it
   in the factory (`.gitignore` already excludes `*.private-key.pem`) and run
   `chmod 600` on it; `jigs doctor` fails on a looser mode.
5. **`installations`**: install the App on the repositories you bind. The
   installation's URL ends in its ID; add it under the account name.
6. **`operator`** is your GitHub login. jigs assigns pull requests to you.
   **`coAuthor`** is optional and adds a `Co-authored-by` line to merge commits.

Every GitHub binding needs an installation for its owner. To use different Apps
for different organizations, add more entries to `identities`; no two may claim
the same account. A PAT must be the only entry.

## Linear identity {#linear-identity}

`linear.identity` says who jigs is on Linear. Choose it with
`jigs init --linear-identity-mode key` (the default) or `app`.

- **`key`: jigs acts as you.** Put a Linear personal API key in `.env` as
  `LINEAR_API_KEY`. Linear does not notify you of your own comments, so when a
  run asks you a question on a ticket, the mention may never reach your inbox.
  A key for a separate Linear user avoids this.
- **`app`: jigs acts as an app.** Its comments and mentions reach you like
  anyone else's. In Linear, go to Settings → API → OAuth applications and create
  one with **Client credentials** on, Public off and Webhooks off (any redirect
  URL will do). Put its ID and secret in `.env` as `LINEAR_CLIENT_ID` and
  `LINEAR_CLIENT_SECRET`, then run `jigs service restart`.

```ts
linear: { identity: { mode: "app" } },
```

## Webhooks {#webhooks}

Webhooks are optional. Without them, waiting runs re-read GitHub and Linear
every [`pollIntervalSeconds`](#service), and nothing else is needed. Webhooks
make runs react in seconds. The poll keeps running underneath, so a lost
delivery only delays a run.

```ts
webhooks: {
  url: "https://my-machine.my-tailnet.ts.net",
  github: { enabled: true },
  linear: { enabled: false },
},
```

1. **Expose the service port** with a tunnel, for example
   `tailscale funnel --bg <servicePort>` or
   `cloudflared tunnel --url http://localhost:<servicePort>`. The public URL is
   `webhooks.url`.
2. **GitHub**: create a secret with `openssl rand -hex 32`, put it in `.env` as
   `GITHUB_WEBHOOK_SECRET`, run `jigs service restart`, then run `jigs bind`
   again for each repository. `bind` creates or repairs the repository's
   webhook. It needs hook permissions: `admin:repo_hook` for a PAT, or
   Repository webhooks read and write for an App.
3. **Linear**: create the webhook yourself in Linear under Settings → API →
   Webhooks, pointing at `<webhooks.url>/ingress/linear`, for `Comment` events
   only. Put its signing secret in `.env` as `LINEAR_WEBHOOK_SECRET` and run
   `jigs service restart`.

A provider that is enabled without its secret stops the service from starting.
`jigs doctor` checks the secrets and, for GitHub, whether recent deliveries were
rejected.

## The `.env` file

`jigs init` writes `.env.example`. Copy it to `.env`; `jigs up` stops if `.env`
is missing, and lists the credentials still empty.

| Variable | When you need it |
| --- | --- |
| `WORKFLOW_TARGET_WORLD`, `WORKFLOW_POSTGRES_URL` | Always. Filled in by `jigs init`; leave them. |
| `GITHUB_TOKEN` | GitHub [PAT mode](#github-identity), once you bind a GitHub repository or a workflow requires `github`. |
| `LINEAR_API_KEY` | Linear [`key` mode](#linear-identity). |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | Linear [`app` mode](#linear-identity). |
| `GITHUB_WEBHOOK_SECRET` | GitHub [webhooks](#webhooks) enabled. |
| `LINEAR_WEBHOOK_SECRET` | Linear [webhooks](#webhooks) enabled. |
| `OPENROUTER_API_KEY` | Workflows that use `models.openrouter()`. |
| `JIGS_CLAUDE_EXECUTABLE` | Optional. Path to `claude` when it is not on the service's `PATH`. |
| `AWS_PROFILE` | Workflows that declare `requires: { aws: true }`. Preflight checks the profile with `aws sts get-caller-identity`. |

`JIGS_SERVICE_URL` is read by the CLI, not the service. Set it in your shell to
point commands such as `jigs status` at a different service, or pass
`--service-url`.
