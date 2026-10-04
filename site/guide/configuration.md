# Configuration

A factory is configured in two files. `jigs.config.ts` holds settings you
commit. `.env` holds secrets and is never committed. There is no other
configuration file.

| You changed | Run |
| --- | --- |
| Workflow code or `jigs.config.ts` | `pnpm exec jigs up` |
| `.env` | `pnpm exec jigs service restart` |

The service reads `.env` when it starts. Here is a complete `jigs.config.ts`
for a factory with the generated `hello` workflow and an `app` binding. Replace
the repository URL with your own:

```ts
// jigs.config.ts
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

The sections below show properties to add or replace **inside the existing
`defineFactory({ ... })` object** in `jigs.config.ts`. Keep the other properties
from your configuration. These smaller blocks are configuration excerpts.

## `workflows`

A map from a workflow's name to a deferred import of its file. The name is what
`jigs run` takes. After creating `workflows/triage/triage.ts` in
[Build a workflow](/guide/build-a-workflow), add its loader alongside `hello`:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
workflows: {
  hello: () => import("./workflows/hello/hello.ts"),
  triage: () => import("./workflows/triage/triage.ts"),
},
```

## `bindings` {#bindings}

A binding names a GitHub repository that workflows may operate on. jigs keeps
its own clone and provisions a separate working copy, called a worktree, for
each run.

The clone and its worktrees live in
`~/.local/share/jigs/clones/<factory>/<name>/` (`$XDG_DATA_HOME/jigs/clones/`
when that is set). That folder belongs to jigs and is separate from the
factory's own `bindings/<name>/` folder described below.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
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
| `remote` | required | The GitHub repository's Git remote URL. |
| `copy` | `[]` | Files to copy into each new worktree. |
| `postCreate` | `[]` | Commands to run in each new worktree, in order. The first failure stops provisioning. |
| `hookTimeoutMinutes` | `10` | The total time `postCreate` may take. |
| `mergeMethod` | `"squash"` | How jigs [merges](#merging) a pull request here: `"squash"`, `"merge"` or `"rebase"`. |

Each `copy` entry is a path, or a glob, inside `bindings/<name>/` in the
factory, and lands at the same path in the worktree. `bindings/app/.env`
arrives as `.env` at the worktree root. Keep secret files there; the
scaffold's `.gitignore` already ignores every `.env`. An entry that matches nothing fails
`jigs doctor`, and stops a run of a workflow that needs the binding before it
starts, with a message naming the missing path.

`jigs bind <remote>` adds a binding with its `remote` and creates
`bindings/<name>/` with a short `README.md` when the folder is missing. It
never touches a folder that already exists, and it does not add `copy`; list
the files you put there yourself. `jigs unbind <name>` removes the binding and
keeps the folder, since it may hold secrets. Add the other keys by hand. Both commands edit a plain object
literal. If `bindings` is computed, they explain why and leave the file alone.

## `service`

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8990` | Where the service listens. The CLI talks to it here. |
| `dashboardPort` | required | Where the service hosts the run dashboard. |
| `pollIntervalSeconds.github` | `300` | How often waiting runs re-read their pull requests. Minimum 30. |
| `pollIntervalSeconds.linear` | `300` | How often runs waiting on a ticket reply re-read it. Minimum 30. |
| `pollIntervalSeconds.slack` | `300` | How often the service reads Slack channels, and runs waiting on a thread reply re-read it. Minimum 30. |
| `pollIntervalSeconds.pagerduty` | `300` | How often [event triggers](#triggers) on PagerDuty look for new incidents. Minimum 30. |

`jigs init` picks ports for each factory so that two factories on one machine
rarely clash.

::: details Changing the Postgres port
The Postgres port appears in both `docker-compose.yml` and
`WORKFLOW_POSTGRES_URL` in `.env`. Change both together. The service and
dashboard ports are separate settings in `jigs.config.ts`.

`docker-compose.yml` publishes Postgres on `127.0.0.1` only, so other machines
on your network cannot reach it. Keep that prefix if you change the port.
:::

## `schedules` {#schedules}

This schedules the `triage` workflow from [Build a workflow](/guide/build-a-workflow)
every Monday. Register `triage` in `workflows` as shown above and use its
`binding` and `report` inputs:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
schedules: {
  "monday-triage": {
    workflow: "triage",
    cron: "0 9 * * 1",
    inputs: { binding: "app", report: "Saving a draft twice loses its title." },
  },
},
```

- Cron uses five fields in the service host's local time.
- Each tick validates inputs and runs preflight, like `jigs run`.
- A tick is skipped while the schedule's previous run is still active.
- Missed ticks while the service was down are not replayed.

`jigs status` lists schedules. Their runs show `schedule:<name>` as the trigger.

## `triggers` {#triggers}

An event trigger starts a run for each new occurrence its source reports, such
as each new PagerDuty incident. Its workflow accepts the
source's inputs next to its own:

```ts
// workflows/respond/respond.ts
import { defineWorkflow } from "@jigs-ai/jigs";
import { z } from "zod";

export default defineWorkflow({
  inputs: z.object({ incident: z.string(), team: z.string() }),
  requires: { integrations: ["pagerduty"] },
  workflow: async ({ incident, team }) => `${team} takes ${incident}`,
});
```

This trigger starts `respond` for every high-urgency incident on one service:

```ts
// jigs.config.ts
import { defineFactory, pagerduty } from "@jigs-ai/jigs";

export default defineFactory({
  service: { port: 8990, dashboardPort: 9090 },
  pagerduty: {
    identity: { mode: "app", subdomain: "acme", region: "us", from: "oncall@example.com" },
  },
  workflows: {
    respond: () => import("./workflows/respond/respond.ts"),
  },
  triggers: {
    "checkout-pages": {
      workflow: "respond",
      source: pagerduty.incidents({ service_ids: ["PABC123"], urgencies: ["high"] }),
      inputs: { team: "payments" },
      maxActive: 2,
    },
  },
});
```

- `source` takes the provider's own query parameters under the provider's own
  names. jigs adds no filter syntax; any finer judgement belongs in the run.
- Each run's inputs are the source's reference, such as `{ incident: "Q1ABC" }`,
  merged over the fixed `inputs`. The run reads the rest itself.
- An occurrence starts at most one run, ever, even if the run decides to do
  nothing or ends while the incident is still open.
- The service polls each source on its provider's
  [`pollIntervalSeconds`](#service). A PagerDuty [webhook](#webhooks) starts
  runs sooner; the poll still finds anything a delivery missed.
- A new trigger starts from the moment the service first runs it, with no
  backfill. After the service was down, it catches up on occurrences within
  `lookbackMinutes` (default 60) and records older ones as skipped.
- At most `maxActive` runs of the trigger are active at once (default 20).
  Further occurrences wait and start oldest first.
- A start that fails validation or preflight is recorded as failed and not
  retried. A preflight check that could not reach its provider is tried again
  for up to five minutes first. `jigs status` and `jigs doctor` show a failed
  start with its repair.

| Source | Occurrence | Inputs | Parameters |
| --- | --- | --- | --- |
| `pagerduty.incidents` | A new incident, whatever its status | `{ incident }` | `service_ids`, `team_ids`, `urgencies` |

A trigger's source needs its provider set up: see [PagerDuty](/guide/pagerduty)
for `pagerduty.incidents`. `jigs doctor` checks that provider for every trigger
that uses it. `jigs status` lists each trigger with its waiting, active and
failed occurrences. Its runs show `trigger:<name>` as the trigger.

## `release` {#release}

Release policy controls what happens to run-owned worktrees and scratch
directories after the run ends:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
release: { onSuccess: "release", onFailure: "keep" },
```

That is the default. `onSuccess` applies to completed runs and `onFailure` to
failed and cancelled ones. A workflow's `defineWorkflow` can set its own `release`.
The service applies the policy when a run ends; waiting runs always keep everything.
Copies of Claude Code skills are always removed, since they hold nothing to inspect.
A workflow that wants to release early, or needs the report, can call
`await release()` from `#jigs/steps`.

jigs does not delete uncommitted or unmerged work it cannot prove is safe to
remove, and never deletes remote branches: `jigs resources prune` lists the ones
runs left on GitHub. See
`jigs resources` in [CLI commands](/guide/cli) to inspect what is left.

## `agents.env` {#agents-env}

Agents do not inherit the service's environment. Each harness starts with a
base set: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, locale variables,
`TZ`, `TMPDIR`, the XDG directories, proxy settings and CA certificate
settings, plus the variables its own harness needs. Give agents anything else
by name:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
agents: { env: ["SSH_AUTH_SOCK", "MISE_DATA_DIR"] },
```

The list holds names only; the values come from the service's environment when
an agent starts. Model keys such as `OPENROUTER_API_KEY` and variables jigs
sets itself cannot be listed; name a model key on its model source instead. An
agent that [acts as the App](/guide/models-and-harnesses#github-access) gets its
GitHub token from jigs, not from this list.
This limits what agents see in their environment only. They still run as your
user and can read any file you can.

## GitHub

### Identity {#github-identity}

`github.identities` says who jigs is on GitHub. Choose the mode when you create
the factory, with `jigs init --github-identity-mode pat` (the default) or `app`.

#### PAT: jigs acts as you

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
github: { identities: [{ mode: "pat" }] },
```

Put a personal access token in `.env` as `GITHUB_TOKEN`. Pull requests jigs
opens are authored by you, so GitHub will not let you approve them: jigs uses
[label approval](#merging). You can still send work back with review comments or a comment on the
pull request. A classic token needs `repo` (or `public_repo`), plus
`admin:repo_hook` if you turn on GitHub webhooks.

#### App: jigs acts as a bot

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
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
else's, so jigs uses [review approval](#merging) unless you choose the label.
Agents can act as the same bot: see
[GitHub access for agents](/guide/models-and-harnesses#github-access).
`jigs init --github-identity-mode app` takes all of these values as flags. To
set one up:

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

### Merging {#merging}

These are three independent decisions:

| Concern | Controlled by |
| --- | --- |
| What counts as operator approval | `github.mergeApproval` |
| Which commits an approving review covers | Workflow code (`approvalCovers`) |
| How GitHub creates the merge | `bindings.<name>.mergeMethod` |
| Whether and when to attempt a merge | Workflow code |

- **`github.mergeApproval`**: what counts as your consent. `"review"` is an
  approving review of the current commit; a new push withdraws it. `"label"`
  is the `jigs:approved` label on the pull request; it survives later pushes,
  so it means "merge whenever ready". The default follows the
  [identity](#github-identity): `"label"` with a PAT, `"review"` with an App.
  A PAT cannot use `"review"`: jigs opens pull requests as you, and GitHub does
  not let you approve your own.
- **`approvalCovers`**: an option workflow code passes to `watchPullRequest`,
  `fetchPullRequestState` and `mergePullRequest`, so two workflows on one
  repository can differ. `"latest-commit"`, the default, counts a review only
  on the commit it approved. `"any-commit"` keeps a person's approval counting
  through later pushes, even a force-push that drops the approved commit, until
  a later review requests changes or the approval is dismissed. Approvals by
  bots never count under `"any-commit"`, so an agent acting as the App's bot
  cannot approve its own work. Changes requested by a bot still block.
- **`bindings.<name>.mergeMethod`**: `"squash"`, `"merge"` or `"rebase"`, as on
  GitHub. Default `"squash"`. With `squash` and `merge`, the pull request title
  becomes the commit title. With `rebase`, each commit is rewritten and loses
  its signature.

`jigs bind` creates the `jigs:approved` label on each GitHub repository it
binds, whichever approval you use.

Workflow code calls `mergePullRequest` when its policy says to merge. That step
rereads GitHub and enforces readiness and approval, read with the
`approvalCovers` it is given. `watchPullRequest` only
reports facts. These checks do not restrict an agent using its own GitHub
tools; see [GitHub access for agents](/guide/models-and-harnesses#github-access).

jigs merges only when the approval is present, GitHub reports the pull request
mergeable, it is not a draft, at least one check has run, and CI is green.
**jigs never merges in a repository with no CI**: when no check has reported,
`jigs status` says so, since CI may not have started yet or the repository may
have none. While GitHub reports `behind`, `blocked` or `unknown`, jigs waits and
checks again later. A label cannot satisfy a branch rule that requires approving
reviews, so label approval only works on repositories without that rule. jigs
never changes branch protection.

A protected branch that restricts who can push also restricts who can merge.
If the account jigs merges as is not on that list (the App, or you with a PAT),
GitHub reports an approved, green pull request as `blocked` and refuses the
merge without saying why. jigs cannot read branch rules without admin access,
so it does not check them ahead of time. It says so in `jigs status`, and the
`linear-ticket-to-pr` recipe also leaves one note on the pull request for each
commit, then keeps watching. Add the account to the branch rule, or set the
recipe's `mergedBy: "human"` and merge those pull requests yourself.

### Call other GitHub endpoints {#call-github}

`callGitHub(method, path, options)` calls any
[GitHub REST endpoint](https://docs.github.com/en/rest) as the factory's
[identity](#github-identity) and returns GitHub's parsed JSON, or `undefined`
when GitHub answers with no content. Use it for anything jigs has no step for,
such as requesting reviewers or finding a commit's author. Call it from your
own `"use step"` function.

A path under `/repos/{owner}/{repo}` uses that owner's installation. For any
other path, such as `/orgs/acme/teams`, pass `account` to name the owner.
`body` is sent as JSON, and the query string goes in the path.

When GitHub answers with an error, `callGitHub` throws a `GitHubApiError` with
the HTTP `status` and GitHub's message as `githubMessage`. A step can run more
than once, so a call should be safe to repeat:

```ts
// workflows/review/steps.ts
import { callGitHub, GitHubApiError } from "@jigs-ai/jigs/steps/pull-requests";

// GitHub refuses the whole request if any one login cannot review, so ask for
// each login on its own and skip the ones GitHub refuses with a 422.
export async function requestReviewers(repo: string, pr: number, logins: string[]) {
  "use step";
  for (const login of logins) {
    try {
      await callGitHub("POST", `/repos/${repo}/pulls/${pr}/requested_reviewers`, {
        body: { reviewers: [login] },
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      console.log(`skipped reviewer ${login}: ${error.githubMessage}`);
    }
  }
}

export async function commitAuthorLogin(repo: string, email: string) {
  "use step";
  const commits = await callGitHub<{ author: { login: string } | null }[]>(
    "GET",
    `/repos/${repo}/commits?author=${encodeURIComponent(email)}&per_page=1`,
  );
  return commits[0]?.author?.login ?? null;
}
```

Workflow code calls these like any step. With an App, the App needs whatever
permission the endpoint asks for, such as Members read for an organization's
teams.

## Linear

### Identity {#linear-identity}

`linear.identity` says who jigs is on Linear. Choose it with
`jigs init --linear-identity-mode key` (the default) or `app`.

- **`key`: jigs acts as you.** Put a Linear personal API key in `.env` as
  `LINEAR_API_KEY`. Linear does not notify you of your own comments, so when a
  run asks you a question on a ticket, the mention may never reach your inbox.
  A key for a separate Linear user, or the `app` identity, avoids this.
- **`app`: jigs acts as an app.** Its comments and mentions reach you like
  anyone else's. In Linear, go to Settings → API → OAuth applications and create
  one with **Client credentials** on, Public off and Webhooks off (any redirect
  URL will do). Put its ID and secret in `.env` as `LINEAR_CLIENT_ID` and
  `LINEAR_CLIENT_SECRET`.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
linear: { identity: { mode: "app" } },
```

### Who comments mention {#linear-operator}

Every comment jigs posts on a Linear ticket starts by mentioning people, so
Linear notifies them. That covers the questions a paused run asks and the notes
it leaves, such as the assumptions a ticket review made.

- **Without `linear.operator`**, a comment mentions the ticket's creator and
  its assignee.
- **With `linear.operator`**, set to the email of your Linear user, a comment
  mentions you and the ticket's assignee instead. Set it when colleagues create
  tickets for the factory, so its questions reach you rather than them.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
linear: { identity: { mode: "app" }, operator: "you@example.com" },
```

Each person is mentioned once, even when the operator is also the assignee.
Anyone's reply wakes a paused run; the mention only decides who is notified.
The operator is one setting for the whole factory. Like the rest of
`jigs.config.ts`, a change takes effect after a rebuild, which `jigs up` does.

A step or routine that posts a comment, such as `haltForHuman` or
`noteOnTicket`, also takes a `mention` list of extra emails to mention
alongside these people.

`jigs doctor`, and `jigs up`, look the operator email up in Linear and fail
when no active Linear user has it. With the `key` identity, jigs posts as the
key's owner, so if that is also the operator, doctor warns that the mentions
will not notify you and suggests the `app` identity.

When a run posts, jigs looks the emails up again. If Linear cannot find one,
for example because the user was deactivated since, jigs leaves that person
out, logs a warning and posts the comment anyway. A mention never stops a run.

## PagerDuty

The `pagerduty` section says which PagerDuty account jigs works on and which
user its notes are attributed to. See [PagerDuty](/guide/pagerduty) for setup.

## Slack {#slack}

`slack` connects the factory's own Slack app. Set it up by following
[Slack](/guide/slack), which has the manifest to paste.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
slack: { socketMode: true },
```

| Key | Default | Meaning |
| --- | --- | --- |
| `socketMode` | required | Receive messages over Socket Mode as they are posted, on top of polling. Needs `SLACK_APP_TOKEN`; without it the service refuses to start. Each factory needs its own Slack app; two factories on one app split its events between them. |
| `scopes` | `[]` | Bot scopes your own Slack calls need on top of the ones jigs uses, such as `reactions:write`. `jigs doctor` checks the bot holds them. See [Call other Slack methods](/guide/slack#call-other-slack-methods). |

The service polls the channels its Slack triggers watch every
[`service.pollIntervalSeconds.slack`](#service) seconds, with Socket Mode on or
off.

To start runs from Slack messages, see
[Start runs from messages](/guide/slack#start-runs-from-messages).

## Webhooks {#webhooks}

Webhooks improve latency, not correctness. Without them, the built-in GitHub
and Linear waits, and [event triggers](#triggers) on PagerDuty, continue to
poll at [`pollIntervalSeconds`](#service). A lost webhook delivery only delays
the next check. See
[Waiting and external events](/guide/waiting-and-events) for how runs wait.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
webhooks: {
  url: "https://my-machine.my-tailnet.ts.net",
  github: { enabled: true },
},
```

Name each provider that sends webhooks with `enabled: true`. A provider you
leave out (here `linear` and `pagerduty`) is off and keeps polling.

1. **Expose the service port** with a tunnel, for example
   `tailscale funnel --bg <servicePort>` or
   `cloudflared tunnel --url http://localhost:<servicePort>`. The public URL is
   `webhooks.url`.
2. **GitHub**: create a secret with `openssl rand -hex 32`, put it in `.env` as
   `GITHUB_WEBHOOK_SECRET`, set `github: { enabled: true }`, run
   `jigs service restart`, then run `jigs bind` again for each repository.
   `bind` creates or repairs the repository's webhook. It needs hook permissions: `admin:repo_hook` for a PAT, or
   Repository webhooks read and write for an App.
3. **Linear**: create the webhook yourself in Linear under Settings → API →
   Webhooks, pointing at `<webhooks.url>/ingress/linear`, for `Comment` events
   only. Put its signing secret in `.env` as `LINEAR_WEBHOOK_SECRET`, set
   `linear: { enabled: true }` and run `jigs service restart`.
4. **PagerDuty**: in PagerDuty, go to **Integrations → Generic Webhooks (v3)**
   and add a subscription on the service or team your triggers watch, for the
   `incident.triggered` event only, delivering to
   `<webhooks.url>/ingress/pagerduty`. Put the signing secret PagerDuty shows
   in `.env` as `PAGERDUTY_WEBHOOK_SECRET`, set `pagerduty: { enabled: true }`
   and run `jigs service restart`. A new incident then starts its run within
   seconds instead of at the next poll, and never starts a second one.

A provider that is enabled without its secret stops the service from starting.
`jigs doctor` checks the secrets, whether recent GitHub deliveries were
rejected, and whether the PagerDuty subscription exists and is active. PagerDuty
switches a subscription off after repeated failed deliveries; enable it again
on its page under **Integrations → Generic Webhooks (v3)**.

## `.env` {#env}

`jigs init` writes `.env.example`. Copy it to `.env`; `jigs up` stops if `.env`
is missing, and lists the credentials still empty.

| Variable | When you need it |
| --- | --- |
| `WORKFLOW_TARGET_WORLD`, `WORKFLOW_POSTGRES_URL` | Always. Filled in by `jigs init`; leave them. A new factory needs nothing else. |
| `GITHUB_TOKEN` | GitHub [PAT mode](#github-identity), once you bind a GitHub repository or a workflow requires `github`. |
| `LINEAR_API_KEY` | Linear [`key` mode](#linear-identity). |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | Linear [`app` mode](#linear-identity). |
| `PAGERDUTY_CLIENT_ID`, `PAGERDUTY_CLIENT_SECRET` | A [`pagerduty`](/guide/pagerduty) section in `jigs.config.ts`. |
| `SLACK_BOT_TOKEN` | A [`slack`](#slack) section, or a workflow that requires `slack`. |
| `SLACK_APP_TOKEN` | [`slack.socketMode`](#slack) on. |
| `OPENROUTER_API_KEY` | Workflows that use `models.openrouter()`. |
| `JIGS_CLAUDE_EXECUTABLE` | Optional. Path to `claude` when it is not on the service's `PATH`. |
| `AWS_PROFILE` | Workflows that declare `requires: { aws: true }`. Preflight checks the profile with `aws sts get-caller-identity`. For an SSO profile it skips cached role credentials, so an expired `aws sso login` fails the check. |
| `GITHUB_WEBHOOK_SECRET` | GitHub [webhooks](#webhooks) enabled. |
| `LINEAR_WEBHOOK_SECRET` | Linear [webhooks](#webhooks) enabled. |
| `PAGERDUTY_WEBHOOK_SECRET` | PagerDuty [webhooks](#webhooks) enabled. |

Also set any variable your `jigs.config.ts` names, such as an MCP server's
`bearerTokenEnv`. An empty value counts as unset, so a value exported in your
shell still reaches the service.

`JIGS_SERVICE_URL` is read by the CLI, not the service. Set it in your shell to
point commands such as `jigs status` at a different service, or pass
`--service-url`.

### A workflow's own secrets {#workflow-secrets}

A workflow that reads a credential of its own lists the variable's name in
`requires.secrets`, and its steps read the value from `process.env`. Add each
name to `.env.example` with an empty value, so a new checkout knows to fill it
in. See [Secrets](/guide/build-a-workflow#secrets).
