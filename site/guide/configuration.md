# Configuration

A factory is configured in two places:

- **`jigs.config.ts` says what the factory is**: its workflows, bindings,
  schedules and triggers, and its hub. You commit it, and every copy of the
  factory runs the same one.
- **The environment says how this running copy is set up**: its ports, its
  docker compose project and database, its hub token, its secrets, and which
  triggers and schedules are [active](#active), with any values of their own.

A copy is one checkout of the factory running its own service: your main
checkout, a [git worktree](/guide/worktrees), or a server.

| You changed | Run |
| --- | --- |
| Workflow code or `jigs.config.ts` | `pnpm exec jigs up` |
| The environment, such as `.env` or `.env.local` | `pnpm exec jigs up --restart-service` |

Here is a complete `jigs.config.ts`
for a factory with the generated `hello` workflow and an `app` binding. Replace
the repository URL with your own, and `github-acme` with the
[installation name](/guide/hub#installation-names) of your GitHub App's
installation on its owner:

```ts
// jigs.config.ts
import { defineFactory } from "@jigs-ai/jigs";

export default defineFactory({
  hub: { url: "https://hub.example.com" },
  bindings: {
    app: { remote: "git@github.com:owner/app.git", installationName: "github-acme" },
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

A factory reaches GitHub, Linear, Slack and PagerDuty only through a
[hub](/guide/hub). The hub receives the factory's events from them and keeps
them until the service collects them, so nothing is lost while the service is
down. It also hands the factory every token it uses on those providers, for
the [apps assigned](/guide/hub#apps) to it. The factory needs no public URL and
holds no provider secret. A factory that uses none of these providers needs no
hub: leave `hub` out.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
hub: { url: "https://hub.example.com" },
```

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | required | The address the hub is reached at. |

A copy is connected to its hub when `hub` is set here and `JIGS_HUB_TOKEN` is
set in its environment. When you [add the factory](/guide/hub#factories), the
hub shows both lines to copy, once: the `hub` line for `jigs.config.ts`, and
the `JIGS_HUB_TOKEN=` line for this copy's `.env.local`. Then run
`pnpm exec jigs up`.

A copy with no connection still starts and runs workflows that use no
provider. It refuses to start while an active trigger, or an active schedule
whose workflow uses a provider, needs the hub, and a run that needs a provider
fails its preflight with `this copy has no hub connection`. `jigs doctor` runs
no hub or provider checks in such a copy, so a copy that is quiet on purpose
gets a clean doctor.

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
    installationName: "github-acme",
    copy: [".env"],
    postCreate: ["pnpm install"],
    hookTimeoutMinutes: 20,
  },
},
```

| Key | Default | Meaning |
| --- | --- | --- |
| `remote` | required | The GitHub repository's Git remote URL. |
| `installationName` | required | The [installation name](/guide/hub#installation-names) of the GitHub App installation that reaches the repository. jigs acts on the repository through it. |
| `copy` | `[]` | Files to copy into each new worktree. |
| `postCreate` | `[]` | Commands to run in each new worktree, in order. The first failure stops provisioning. |
| `hookTimeoutMinutes` | `10` | The total time `postCreate` may take. |

Each `copy` entry is a path, or a glob, inside `bindings/<name>/` in the
factory, and lands at the same path in the worktree. `bindings/app/.env`
arrives as `.env` at the worktree root. Keep secret files there; the
scaffold's `.gitignore` already ignores every `.env`. An entry that matches nothing fails
`jigs doctor`, and stops a run of a workflow that needs the binding before it
starts, with a message naming the missing path.

`jigs bind <remote> --installation <installation>` adds a binding with its `remote`
and `installationName`, and creates
`bindings/<name>/` with a short `README.md` when the folder is missing. It
never touches a folder that already exists, and it does not add `copy`; list
the files you put there yourself. `jigs unbind <name>` removes the binding and
keeps the folder, since it may hold secrets. Add the other keys by hand. Both commands edit a plain object
literal. If `bindings` is computed, they explain why and leave the file alone.

## `schedules` {#schedules}

This schedules the `triage` workflow from [Build a workflow](/guide/build-a-workflow)
every Monday. Register `triage` in `workflows` as shown above and use its
`binding` and `report` inputs:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
schedules: {
  "monday-triage": {
    active: process.env.MONDAY_TRIAGE_ACTIVE === "true",
    workflow: "triage",
    cron: "0 9 * * 1",
    inputs: { binding: "app", report: "Saving a draft twice loses its title." },
  },
},
```

- `active` is required. An inactive schedule never fires; see
  [Active triggers and schedules](#active).
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
  inputs: z.object({ installationName: z.string(), incident: z.string(), team: z.string() }),
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
  workflows: {
    respond: () => import("./workflows/respond/respond.ts"),
  },
  triggers: {
    "checkout-pages": {
      active: process.env.CHECKOUT_PAGES_ACTIVE === "true",
      workflow: "respond",
      source: pagerduty.incidents({
        installationName: "pagerduty-acme",
        services: ["PABC123"],
        urgencies: ["high"],
      }),
      inputs: { team: "payments" },
      maxActive: 2,
    },
  },
});
```

- `active` is required. An inactive trigger starts no runs; see
  [Active triggers and schedules](#active).
- `source` takes the [installation name](/guide/hub#installation-names) it
  listens to, and the provider's own query parameters under the provider's own
  names. jigs adds no filter syntax; any finer judgement belongs in the run.
- A source takes only events from its own installation. Another installation
  assigned to the factory, even a second app in the same workspace that sees
  the same message, never starts or wakes its runs.
- Each run's inputs are the source's reference, such as
  `{ installationName: "pagerduty-acme", incident: "Q1ABC" }`, merged over the
  fixed `inputs`. The run reads the rest itself, through that installation.
- An occurrence starts at most one run, ever, even if the run decides to do
  nothing or ends while the incident is still open.
- Occurrences arrive as provider events through the [hub](#hub). The hub
  keeps the events that arrive while the service is down and hands them over
  when it is back.
- An event from an installation with no name reaches no trigger, and wakes no
  run. Name the installation on the hub: events it received before then, but
  has not yet handed over, carry the name once it is set.
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
| `pagerduty.incidents` | A new incident, whatever its status | `{ installationName, incident }` | `installationName`, `services`, `teams`, `urgencies` |
| `linear.agentSessions` | A mention of the Linear app on an issue, or an issue assigned to it | `{ session, installationName, issue, comment, promptContext, creator }` | `installationName`, `teams`, `projects`, `labels` |
| `slack.messages`, `slack.mentions` | A top-level message, or one that mentions the bot | `{ installationName, channel, ts }` | `installationName`, `channels` |

`installationName` is required on every source.

A trigger's source needs its provider set up: see [PagerDuty](/guide/pagerduty)
for `pagerduty.incidents`, [Linear](#linear-app) for `linear.agentSessions`
and [Slack](/guide/slack) for `slack.messages` and `slack.mentions`.
`jigs doctor` checks the installation every trigger names. `jigs status` lists each trigger with its waiting, active and
failed occurrences. Its runs show `trigger:<name>` as the trigger and, from
the moment they start, the occurrence under SOURCE, such as
`slack C0123ABCD 1790723244.335019` or `pagerduty Q1ABCDEF`.

### Linear mentions and assignments {#linear-agent-sessions}

`linear.agentSessions` starts a run each time someone mentions the Linear app
on an issue or assigns an issue to it, in the workspace its `installationName`
names. Linear calls each of these an
agent session. The hub posts the session's first reply at once, so Linear shows
the app at work while the run starts. Each run gets:

- `session`: the agent session's id, which is also the occurrence, so a
  session starts at most one run even if Linear sends it twice.
- `installationName`: the trigger's Linear installation. Pass it to the Linear
  steps and routines the run calls.
- `issue`: the issue's `id`, `identifier`, `title` and `url`.
- `comment`: the body of the comment the session started from, or `null` for
  an assignment.
- `promptContext`: Linear's formatted context for the session, with the issue,
  its description and the comments around the request, or `null` if Linear
  sent none.
- `creator`: the `id`, `name` and `email` of who started it.

`teams` takes team keys such as `ENG` or team ids, `projects` takes project
ids or the id at the end of a project's URL, and `labels` takes label names.
Sessions not on an issue start no run, and neither do sessions no person
started, such as the ones ticket runs open.

```ts
import { linear } from "@jigs-ai/jigs";

// In defineFactory's `triggers`.
const triggers = {
  "fix-on-mention": {
    active: process.env.FIX_ON_MENTION_ACTIVE === "true",
    workflow: "fix",
    source: linear.agentSessions({
      installationName: "linear-acme",
      teams: ["ENG"],
      labels: ["agent"],
    }),
  },
};
```

To have Claude Code answer in the session and keep answering replies, call
`linearAgentConversation` in the run; see
[Linear conversations](/guide/linear-conversations).

Every factory assigned the app hears every mention of it, and each trigger on
this source in each of those factories starts its own run. jigs does not pick
one for you: give each purpose its own Linear app, or split the issues between
triggers with `teams`, `projects` and `labels`.

The hub replies "Received — working on it." to every session before any
factory reads it, so that reply appears even when this factory's filters skip
the session and no run starts. Make the filters match what the app is for, so
that a mention the app answers is one a run takes.

## Active triggers and schedules {#active}

Every schedule and trigger has a required `active` flag, and only active ones
run. An inactive schedule never fires. An inactive trigger starts no runs, and
`jigs doctor` does not check it. Neither needs a hub connection.

The examples on this page read the flag from the environment, as in
`active: process.env.MONDAY_TRIAGE_ACTIVE === "true"`, so each copy decides
for itself:

- A new copy is quiet until you turn something on. Set
  `MONDAY_TRIAGE_ACTIVE=true` in the `.env.local` of the copy that should run
  it, never in the shared `.env`, so a worktree you copy `.env` into does not
  run it too.
- A trigger can read its other per-copy values from the environment the same
  way, such as the Slack channel a test copy listens in.
- `active: true` runs it in every copy.
- The service logs `[schedule] <name> inactive` or `[trigger] <name> inactive`
  when it starts, and `jigs status` shows each under `STATE`.
- A change takes `pnpm exec jigs up --restart-service`. When a trigger is
  inactive, the service skips the occurrences it had waiting, so turning it on
  again never starts runs for older events.

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
and assigns to the factory. Each binding's `installationName` names the App
installation that reaches its repository, and the factory asks the hub for that
installation's tokens. Pull requests come from `<app-slug>[bot]`, and you review
them like anyone else's. Agents can act as the same bot: see
[GitHub access for agents](/guide/models-and-harnesses#github-access).

`jigs doctor` checks that each binding's installation is named and assigned to
the factory in the hub, and that it reaches the binding's repository.

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

`callGitHub(method, path, { installationName, body })` calls any
[GitHub REST endpoint](https://docs.github.com/en/rest) as the factory's
[App](#github-app), through the installation `installationName` names, and returns GitHub's parsed JSON, or `undefined`
when GitHub answers with no content. Use it for anything jigs has no step for,
such as requesting reviewers or finding a commit's author. Call it from your
own `"use step"` function.

A worktree carries its binding's installation as `worktree.installationName`.
`body` is sent as JSON, and the query string goes in the path.

When GitHub answers with an error, `callGitHub` throws a `GitHubApiError` with
the HTTP `status` and GitHub's message as `githubMessage`. A step can run more
than once, so a call should be safe to repeat:

```ts
// workflows/review/steps.ts
import { callGitHub, GitHubApiError } from "@jigs-ai/jigs/steps/pull-requests";

// GitHub refuses the whole request if any one login cannot review, so ask for
// each login on its own and skip the ones GitHub refuses with a 422.
export async function requestReviewers(
  installationName: string,
  repo: string,
  pr: number,
  logins: string[],
) {
  "use step";
  for (const login of logins) {
    try {
      await callGitHub("POST", `/repos/${repo}/pulls/${pr}/requested_reviewers`, {
        installationName,
        body: { reviewers: [login] },
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      console.log(`skipped reviewer ${login}: ${error.githubMessage}`);
    }
  }
}

export async function commitAuthorLogin(installationName: string, repo: string, email: string) {
  "use step";
  const commits = await callGitHub<{ author: { login: string } | null }[]>(
    "GET",
    `/repos/${repo}/commits?author=${encodeURIComponent(email)}&per_page=1`,
    { installationName },
  );
  return commits[0]?.author?.login ?? null;
}
```

Workflow code calls these like any step. With an App, the App needs whatever
permission the endpoint asks for, such as Members read for an organization's
teams.

## Linear

### The factory's Linear app {#linear-app}

jigs acts on Linear as a [Linear app](/guide/hub-linear) the hub assigns the
factory, so its messages and mentions reach you like anyone else's. Connect
the app to your Linear workspace in the hub, name that installation, such as
`linear-acme`, and assign the app to the factory; the hub hands the factory its
tokens and refreshes them. Every Linear step, routine, trigger and agent takes
the `installationName` it acts through. Nothing about the app goes in
`jigs.config.ts` or the environment. `jigs doctor` checks each Linear installation the
factory names, and says when a workspace must be connected again in the hub.

Use one Linear app per purpose: two factories assigned the same app both answer
a mention of it; see [Linear mentions and assignments](#linear-agent-sessions).

### Who a ticket run mentions {#linear-operator}

A ticket run talks to people in its Linear agent session, and every question
and note it posts there starts by mentioning people, so Linear notifies them.
That covers the questions a paused run asks and the notes it leaves, such as
the assumptions a ticket review made.

- **Without `linear.operator`**, a message mentions the ticket's creator and
  its assignee.
- **With `linear.operator`**, set to the email of your Linear user, a message
  mentions you and the ticket's assignee instead. Set it when colleagues create
  tickets for the factory, so its questions reach you rather than them.

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
linear: { operator: "you@example.com" },
```

Each person is mentioned once, even when the operator is also the assignee.
Anyone's reply in the session answers a paused run; the mention only decides
who is notified.
The operator is one setting for the whole factory. Like the rest of
`jigs.config.ts`, a change takes effect after a rebuild, which `jigs up` does.

A step or routine that posts in the session, such as `haltForHuman` or
`noteOnTicket`, also takes a `mention` list of extra emails to mention
alongside these people.

`jigs doctor`, and `jigs up`, look the operator email up in each Linear
installation the factory uses and fail when no active Linear user there has it.

When a run posts, jigs looks the emails up again. If Linear cannot find one,
for example because the user was deactivated since, jigs leaves that person
out, logs a warning and posts the message anyway. A mention never stops a run.

## PagerDuty {#pagerduty}

jigs acts on PagerDuty as a [PagerDuty app](/guide/hub-pagerduty) its hub
assigns the factory. Every PagerDuty step, trigger and agent takes the
`installationName` of the account it acts in. Notes are attributed to the from
user set on that installation in the hub. Nothing about the app goes in
`jigs.config.ts`. See [PagerDuty](/guide/pagerduty) for setup.

## Slack {#slack}

jigs talks to Slack as a [Slack app](/guide/hub-slack) its hub assigns the
factory. Every Slack step, routine and trigger takes the `installationName` of
the workspace it acts in. Nothing about the app goes in `jigs.config.ts`. See
[Slack](/guide/slack) for what workflows do with it, and
[Start runs from messages](/guide/slack#start-runs-from-messages) to start runs
from Slack.

## The environment {#env}

jigs reads only the process environment. It has no code of its own for `.env`
files. The `jigs.config.ts` that `jigs init` writes fills the environment
itself, by loading two files when they exist:

```ts
// jigs.config.ts
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
```

- **`.env.local`** holds this copy's values: the ones in the second table
  below, the `*_ACTIVE` flags of the triggers and schedules it runs, and any
  value only this copy uses, such as a test channel.
- **`.env`** holds the values every copy shares: API keys, secrets and channel
  IDs. Copy it into each new worktree.

Neither file is committed. A value already set is never replaced, so the shell
wins, then `.env.local`, then `.env`. That is also why other loaders work:
start jigs under mise, direnv or `op run`, or load the files with dotenv
instead, and jigs sees whatever ends up in the environment. A deployed copy
needs neither file: set its variables through its platform, such as its
container's environment or a secrets manager.

The service inherits the environment of the `jigs up` that started it.

`jigs init` writes `.env.example`, with the shared values, and
`.env.local.example`, with this copy's values and the ports it suggests. Copy
them to `.env` and `.env.local`. jigs treats an empty value as unset, but an
empty `X=` in `.env.local` still hides the value of `X` in `.env`, so leave out
what you don't set.

These are the values every copy shares, in `.env`:

| Variable | When you need it |
| --- | --- |
| `WORKFLOW_TARGET_WORLD` | Always. Filled in by `jigs init`; leave it. |
| `OPENROUTER_API_KEY` | Workflows that use `models.openrouter()`. |
| `JIGS_CLAUDE_EXECUTABLE` | Optional. Path to `claude` when it is not on the service's `PATH`. |
| `AWS_PROFILE` | Workflows that declare `requires: { aws: true }`. Preflight checks the profile with `aws sts get-caller-identity`. For an SSO profile it skips cached role credentials, so an expired `aws sso login` fails the check. |

These are this copy's own, in `.env.local`:

| Variable | When you need it |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | Always. This copy's docker compose project, so each copy has its own Postgres. |
| `JIGS_SERVICE_PORT`, `JIGS_DASHBOARD_PORT`, `JIGS_POSTGRES_PORT` | Always. Where this copy's service, dashboard and Postgres listen. `jigs init` suggests ports from the factory's path. The service refuses to start without its two. |
| `WORKFLOW_POSTGRES_URL` | Always. This copy's database, on `JIGS_POSTGRES_PORT`. |
| `JIGS_HUB_TOKEN` | Once a workflow, binding or trigger uses GitHub, Linear, Slack or PagerDuty. The factory token the [hub](#hub) showed. GitHub, Linear, Slack and PagerDuty tokens come from the hub. |

Also set any variable your `jigs.config.ts` names, such as an MCP server's
`bearerTokenEnv`, in the file it belongs to.

`JIGS_SERVICE_URL` is read by the CLI, not the service. Set it in your shell to
point commands such as `jigs status` at a different service, or pass
`--service-url`.

### A workflow's own secrets {#workflow-secrets}

A workflow that reads a credential of its own lists the variable's name in
`requires.secrets`, and its steps read the value from `process.env`. Add each
name to `.env.example` with an empty value, so a new
checkout knows to fill it in. See [Secrets](/guide/build-a-workflow#secrets).
