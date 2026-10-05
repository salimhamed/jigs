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
  hub: { url: "https://hub.example.com" },
  service: { port: 8990, dashboardPort: 9090 },
  bindings: {
    app: { remote: "git@github.com:owner/app.git" },
  },
  github: { operator: "your-github-login" },
  linear: { operator: "you@example.com" },
  workflows: {
    hello: () => import("./workflows/hello/hello.ts"),
  },
});
```

The sections below show properties to add or replace **inside the existing
`defineFactory({ ... })` object** in `jigs.config.ts`. Keep the other properties
from your configuration. These smaller blocks are configuration excerpts.

## `hub` {#hub}

Every factory works through a [hub](/guide/hub). The hub receives the
factory's GitHub, Linear, Slack and PagerDuty events and keeps them until the
service collects them, so nothing is lost while the service is down. It also
hands the factory every token it uses on those providers, for the
[apps assigned](/guide/hub#apps) to it. The factory needs no public URL and
holds no provider secret.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
hub: { url: "https://hub.example.com" },
```

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | required | The address the hub is reached at. |

The hub shows a factory token once, when you
[add the factory](/guide/hub#factories) to it. Set both with:

```sh
pnpm exec jigs hub connect https://hub.example.com <token>
```

It writes `url` here and the token to `.env` as `JIGS_HUB_TOKEN`. Then run
`pnpm exec jigs up`. Without the token, `jigs up` stops and the service
refuses to start. `jigs doctor` checks that the hub answers and takes the
token.

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
  },
},
```

| Key | Default | Meaning |
| --- | --- | --- |
| `remote` | required | The GitHub repository's Git remote URL. |
| `copy` | `[]` | Files to copy into each new worktree. |
| `postCreate` | `[]` | Commands to run in each new worktree, in order. The first failure stops provisioning. |
| `hookTimeoutMinutes` | `10` | The total time `postCreate` may take. |

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
  hub: { url: "https://hub.example.com" },
  service: { port: 8990, dashboardPort: 9090 },
  pagerduty: { from: "oncall@example.com" },
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
- Occurrences arrive as provider events through the [hub](#hub). The hub
  keeps the events that arrive while the service is down and hands them over
  when it is back.
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
| `linear.agentSessions` | A mention of the factory's Linear app on an issue, or an issue assigned to it | `{ session, workspace, issue, comment, creator }` | `teams`, `projects`, `labels` |

A trigger's source needs its provider set up: see [PagerDuty](/guide/pagerduty)
for `pagerduty.incidents` and [Linear](#linear-app) for
`linear.agentSessions`. `jigs doctor` checks that provider for every trigger
that uses it. `jigs status` lists each trigger with its waiting, active and
failed occurrences. Its runs show `trigger:<name>` as the trigger and, from
the moment they start, the occurrence under SOURCE, such as
`slack C0123ABCD 1790723244.335019` or `pagerduty Q1ABCDEF`.

### Linear mentions and assignments {#linear-agent-sessions}

`linear.agentSessions` starts a run each time someone mentions the factory's
Linear app on an issue or assigns an issue to it. Linear calls each of these an
agent session. The hub posts the session's first reply at once, so Linear shows
the app at work while the run starts. Each run gets:

- `session`: the agent session's id, which is also the occurrence, so a
  session starts at most one run even if Linear sends it twice.
- `workspace`: the id of the Linear workspace the session is in.
- `issue`: the issue's `id`, `identifier`, `title` and `url`.
- `comment`: the body of the comment the session started from, or `null` for
  an assignment.
- `creator`: the `id`, `name` and `email` of who started it, or `null` for an
  automation.

`teams` takes team keys such as `ENG` or team ids, `projects` takes project
ids or the id at the end of a project's URL, and `labels` takes label names.
Sessions not on an issue start no run.

```ts
import { linear } from "@jigs-ai/jigs";

// In defineFactory's `triggers`.
const triggers = {
  "fix-on-mention": {
    workflow: "fix",
    source: linear.agentSessions({ teams: ["ENG"], labels: ["agent"] }),
  },
};
```

Every factory assigned the app hears every mention of it, and each trigger on
this source in each of those factories starts its own run. jigs does not pick
one for you: give each purpose its own Linear app, or split the issues between
triggers with `teams`, `projects` and `labels`.

The hub replies "Received — working on it." to every session before any
factory reads it, so that reply appears even when this factory's filters skip
the session and no run starts. Make the filters match what the app is for, so
that a mention the app answers is one a run takes.

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

### The factory's App {#github-app}

jigs acts on GitHub as a [GitHub App](/guide/hub-github) that your hub holds
and assigns to the factory. For each repository owner, the factory asks the hub for a token of
the assigned App installed on that owner. Pull requests come from
`<app-slug>[bot]`, and you review them like anyone else's. Agents can act as the
same bot: see [GitHub access for agents](/guide/models-and-harnesses#github-access).

Every GitHub binding needs one of the factory's Apps installed on its owner, and
only one. `jigs doctor` checks this against the hub.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
github: {
  operator: "your-github-login",
  coAuthor: "Your Name <you@example.com>",
},
```

**`operator`** is optional: your GitHub login. jigs assigns its pull requests
to you and names you in them. **`coAuthor`** is optional and adds a
`Co-authored-by` line to merge commits.

### Merging {#merging}

These are three independent decisions:

| Concern | Controlled by |
| --- | --- |
| What counts as operator approval | `github.mergeApproval` |
| Which commits an approving review covers | Workflow code (`approvalCovers`) |
| How GitHub creates the merge | The repository's merge settings on GitHub |
| Whether and when to attempt a merge | Workflow code |

- **`github.mergeApproval`**: what counts as your consent. `"review"` is an
  approving review of the current commit; a new push withdraws it. `"label"`
  is the `jigs:approved` label on the pull request; it survives later pushes,
  so it means "merge whenever ready". The default is `"review"`.
- **`approvalCovers`**: an option workflow code passes to `watchPullRequest`,
  `fetchPullRequestState` and `mergePullRequest`, so two workflows on one
  repository can differ. `"latest-commit"`, the default, counts a review only
  on the commit it approved. `"any-commit"` keeps a person's approval counting
  through later pushes, even a force-push that drops the approved commit, until
  a later review requests changes or the approval is dismissed. Approvals by
  bots never count under `"any-commit"`, so an agent acting as the App's bot
  cannot approve its own work. Changes requested by a bot still block.
- **The merge method** is the first one the repository allows on GitHub, read
  at each merge: squash, then merge commit, then rebase. To get a different
  method, turn off the ones ahead of it in the repository's settings. With
  squash and merge commits, the pull request title becomes the commit title.
  With rebase, each commit is rewritten and loses its signature. A repository
  that allows none fails the merge with a message naming it.

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
If the factory's App is not on that list,
GitHub reports an approved, green pull request as `blocked` and refuses the
merge without saying why. jigs cannot read branch rules without admin access,
so it does not check them ahead of time. It says so in `jigs status`, and the
`linear-ticket-to-pr` recipe also leaves one note on the pull request for each
commit, then keeps watching. Add the account to the branch rule, or set the
recipe's `mergedBy: "human"` and merge those pull requests yourself.

### Call other GitHub endpoints {#call-github}

`callGitHub(method, path, options)` calls any
[GitHub REST endpoint](https://docs.github.com/en/rest) as the factory's
[App](#github-app) and returns GitHub's parsed JSON, or `undefined`
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

### The factory's Linear app {#linear-app}

jigs acts on Linear as the [Linear app](/guide/hub-linear) the hub assigns the
factory, so its comments and mentions reach you like anyone else's. Connect
the app to your Linear workspace in the hub and assign it to the factory; the
hub hands the factory its tokens and refreshes them. For now a factory works
in one Linear workspace. Nothing about the app goes in
`jigs.config.ts` or `.env`. `jigs doctor` checks that the hub has a Linear
token for the factory, and says when a workspace must be connected again in
the hub.

Use one Linear app per purpose: two factories assigned the same app both answer
a mention of it; see [Linear mentions and assignments](#linear-agent-sessions).

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
linear: { operator: "you@example.com" },
```

Each person is mentioned once, even when the operator is also the assignee.
Anyone's reply wakes a paused run; the mention only decides who is notified.
The operator is one setting for the whole factory. Like the rest of
`jigs.config.ts`, a change takes effect after a rebuild, which `jigs up` does.

A step or routine that posts a comment, such as `haltForHuman` or
`noteOnTicket`, also takes a `mention` list of extra emails to mention
alongside these people.

`jigs doctor`, and `jigs up`, look the operator email up in Linear and fail
when no active Linear user has it.

When a run posts, jigs looks the emails up again. If Linear cannot find one,
for example because the user was deactivated since, jigs leaves that person
out, logs a warning and posts the comment anyway. A mention never stops a run.

## PagerDuty {#pagerduty}

jigs acts on PagerDuty as the [PagerDuty app](/guide/hub-pagerduty) its hub
assigns the factory. The `pagerduty` section names the user its notes are attributed to.
See [PagerDuty](/guide/pagerduty) for setup.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
pagerduty: { from: "oncall@example.com" },
```

| Key | Default | Meaning |
| --- | --- | --- |
| `from` | required | The email of a PagerDuty user. PagerDuty refuses a write that names no user, so every note jigs adds is attributed to them. `jigs doctor` checks a user has it. |

## Slack {#slack}

`slack` says the factory uses the [Slack app](/guide/hub-slack) its hub
assigns it. See [Slack](/guide/slack) for what workflows do with it.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
slack: { scopes: ["reactions:write"] },
```

| Key | Default | Meaning |
| --- | --- | --- |
| `scopes` | `[]` | Bot scopes your own Slack calls need on top of the ones jigs uses, such as `reactions:write`. `jigs doctor` checks the workspace granted them. See [Call other Slack methods](/guide/slack#call-other-slack-methods). |

To start runs from Slack messages, see
[Start runs from messages](/guide/slack#start-runs-from-messages).

## `.env` {#env}

`jigs init` writes `.env.example`. Copy it to `.env`; `jigs up` stops if `.env`
is missing.

| Variable | When you need it |
| --- | --- |
| `WORKFLOW_TARGET_WORLD`, `WORKFLOW_POSTGRES_URL` | Always. Filled in by `jigs init`; leave them. |
| `JIGS_HUB_TOKEN` | Always. The factory token the [hub](#hub) showed; `jigs hub connect` sets it. GitHub, Linear, Slack and PagerDuty tokens come from the hub. |
| `OPENROUTER_API_KEY` | Workflows that use `models.openrouter()`. |
| `JIGS_CLAUDE_EXECUTABLE` | Optional. Path to `claude` when it is not on the service's `PATH`. |
| `AWS_PROFILE` | Workflows that declare `requires: { aws: true }`. Preflight checks the profile with `aws sts get-caller-identity`. For an SSO profile it skips cached role credentials, so an expired `aws sso login` fails the check. |

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
