# Run a hub

A hub is one service that receives every GitHub, Linear, Slack and PagerDuty
event for your factories and holds every credential they use. A factory never
needs a public URL or a provider secret: it asks its hub for what happened
and for short-lived tokens, and the hub answers only for the apps you assigned
to it.

One hub serves an **Organization**: its members, its apps on each provider and
its factories. Even a single person running one factory on a laptop runs a
hub, usually on the same machine.

```text
GitHub, Linear, Slack, PagerDuty ──▶ hub (public URL) ◀── factories ask for events and tokens
```

The hub keeps each factory's provider events in order until the factory
confirms them, so nothing is lost while a factory's service is down. A
factory that stays away longer than the retention loses the events older
than it; the hub tells the factory, and every waiting run checks its
provider again. While the hub itself is down, providers cannot reach it and
runs that wait on them do not progress.

Run the hub at the same version as your factories' `@jigs-ai/jigs`, and
upgrade them together.

## What you need

- **Node.js 24 or newer**, or Docker to run the hub in a container.
- **A Postgres database** for the hub alone, never a factory's.
- **One public HTTPS address**, such as `https://hub.example.com`, that
  GitHub, Linear, Slack and PagerDuty can reach, and that you and your
  factories open. A [Tailscale Funnel](#tailscale-funnel) gives you one
  without a server.
- **A GitHub OAuth app for signing in**, described in
  [First sign-in](#first-sign-in).

## Settings

The hub reads its settings from the environment when it starts, and refuses
to start with a message naming every missing or bad value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUB_PUBLIC_URL` | required | The one address people, providers and factories reach the hub at. It must be a bare origin, such as `https://hub.example.com`, with no path. |
| `HUB_DATABASE_URL` | required | The Postgres connection URL of the hub's database. |
| `HUB_ENCRYPTION_KEY` | required | 32 random bytes in base64, from `openssl rand -base64 32`. Every secret the hub stores is encrypted with it, and sign-in sessions are signed with a key made from it. |
| `HUB_GITHUB_CLIENT_ID` | required | The client ID of the GitHub OAuth app people sign in with. |
| `HUB_GITHUB_CLIENT_SECRET` | required | That OAuth app's client secret. |
| `HUB_ADMIN_EMAIL` | required | The email of the person who creates the Organization: the first to sign in with a GitHub account whose [sign-in email](#first-sign-in) is this one. |
| `HUB_RETENTION_DAYS` | `7` | How many days the hub keeps a factory's provider events, confirmed or not. |
| `HOST` | `127.0.0.1` | The address the hub listens on. Set `0.0.0.0` in a container. |
| `PORT` | `3000` | The port the hub listens on. |

Keep `HUB_ENCRYPTION_KEY` safe and never change it. Without it, the hub
cannot read any app secret, Linear or Slack token it holds, and you would
add every app and connect every workspace again.

The hub applies its database migrations each time it starts. It stops
cleanly on `SIGTERM`, so any process manager can restart it.

## Start the hub

The hub is published on npm as `@jigs-ai/hub`, with a `jigs-hub` command.
Start a Postgres for it first, for example in Docker:

```sh
docker run -d --name jigs-hub-postgres --restart unless-stopped \
  -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
  -p 127.0.0.1:5490:5432 -v jigs-hub-postgres:/var/lib/postgresql/data \
  postgres:17
```

Put the settings in a file, such as `hub.env`, and start the hub with them,
pinned to your factories' jigs version:

```sh
# hub.env
HUB_PUBLIC_URL=https://hub.example.com
HUB_DATABASE_URL=postgres://hub:hub@127.0.0.1:5490/hub
HUB_ENCRYPTION_KEY=...
HUB_GITHUB_CLIENT_ID=...
HUB_GITHUB_CLIENT_SECRET=...
HUB_ADMIN_EMAIL=you@example.com
```

```sh
set -a; . ./hub.env; set +a
npx @jigs-ai/hub@<version>
```

It prints `hub listening on http://127.0.0.1:3000`. Open `HUB_PUBLIC_URL`
to sign in.

For a local trial, `HUB_PUBLIC_URL=http://127.0.0.1:3000` works for signing
in and adding factories, but providers cannot reach it: no webhooks arrive, and
some providers refuse a plain `http` OAuth redirect, until the hub has a public
`https` address.

A proxy in front of the hub, such as Funnel or a load balancer, must connect
from the same machine or a private network address. The hub limits sign-in
attempts per client, and it reads the client's address from the proxy's
`X-Forwarded-For` header only when the proxy connects from one of those.

### Tailscale Funnel {#tailscale-funnel}

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) publishes a port on
your machine at a public HTTPS address on your tailnet's domain. With the hub
on port 3000:

```sh
tailscale funnel --bg 3000
```

Funnel prints the address, such as `https://laptop.example-tailnet.ts.net`.
Set `HUB_PUBLIC_URL` to it and start the hub. The hub can keep listening on
`127.0.0.1`, since Funnel connects from the same machine.

### Docker image {#docker}

There is no published image. Build your own from the npm package, pinned to
an exact version so a rebuild never upgrades the hub by surprise:

```dockerfile
FROM node:24-slim
RUN npm install --global @jigs-ai/hub@<version>
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
CMD ["jigs-hub"]
```

```sh
docker build -t jigs-hub .
docker run -d --name jigs-hub --restart unless-stopped \
  --env-file hub.env -p 3000:3000 jigs-hub
```

`HUB_DATABASE_URL` must name a Postgres the container can reach, which is
not `127.0.0.1` on the host. Put the hub and its Postgres on one Docker
network and use the Postgres container's name as the host.

## First sign-in {#first-sign-in}

People sign in to the hub with GitHub, through a GitHub OAuth app that is
separate from the GitHub Apps your factories act as. Create it on GitHub under
**Settings → Developer settings → OAuth Apps → New OAuth App**, or under your
organization's Developer settings:

- **Homepage URL**: `HUB_PUBLIC_URL`.
- **Redirect URI**, under **Redirect URIs**: `HUB_PUBLIC_URL` followed by
  `/api/auth/callback/github`, such as
  `https://hub.example.com/api/auth/callback/github`.
- Leave **Allow wildcard matching** and **Enable Device Flow** off. **Expire
  user access tokens** doesn't matter: the hub uses GitHub only to learn who
  signs in.

Generate a client secret, and set the client ID and secret as
`HUB_GITHUB_CLIENT_ID` and `HUB_GITHUB_CLIENT_SECRET`.

The hub knows a person by their GitHub account's **sign-in email**: its public
email, or its primary email when it shows none publicly. That email must be
verified on GitHub, or the hub refuses the sign-in.

Then open the hub and choose **Sign in with GitHub** with the account whose
sign-in email is `HUB_ADMIN_EMAIL`. The hub asks you to name the
Organization and makes you its first admin. Only one Organization is created
this way; after that, the hub is invite-only.

## Members {#members}

Under **Invites**, an admin invites a person by their GitHub account's
[sign-in email](#first-sign-in), as an admin or a member. The hub sends no email: copy the invite
link it shows and send it yourself. The person opens the link and signs in
with the GitHub account whose sign-in email that is.

Admins add apps and factories, assign them, invite people and change roles
under **Members**. Members see everything but change nothing.

## Add a factory {#factories}

Under **Factories**, an admin adds a factory by name. The hub shows a command
with the factory's token, once:

```sh
jigs hub connect https://hub.example.com <token>
```

Run it in the factory's directory, after creating its `.env`:

```sh
cp .env.example .env
pnpm exec jigs hub connect https://hub.example.com <token>
```

It writes the hub's URL to `jigs.config.ts` and the token to `.env` as
`JIGS_HUB_TOKEN`. Then run `pnpm exec jigs up`.

If the token is lost, **Re-issue token** makes a new one and stops the old
one at once. **Remove** deletes the factory and every event waiting for it.

The factories list shows when each factory last reached the hub, its jigs
version and how many events it has not confirmed. A factory's own page lists
its assigned apps with their installations' names, and its event log: every
provider event the hub kept for it, with when it arrived and whether the
factory has confirmed it.

## Add apps and assign them {#apps}

An app is your Organization's own identity on a provider: a GitHub App, a
Linear OAuth app, a Slack app or a PagerDuty app. You create each one by hand
on the provider, then add it under **Apps**. Its page on the hub shows the
exact URLs and settings to put back on the provider, and installs or connects
it.

- [GitHub App](/guide/hub-github)
- [Linear app](/guide/hub-linear)
- [Slack app](/guide/hub-slack)
- [PagerDuty app](/guide/hub-pagerduty)

Then, on the app's page under **Factories**, check each factory that should
use it and save. That is an **assignment**: a factory receives events from,
and gets tokens for, only the apps assigned to it. An app can be assigned to
several factories, and every one of them receives its events.

A factory may be assigned several installations of one provider, including
several apps in one workspace or GitHub organization. It names the
[installation](#installation-names) it means everywhere: in each binding, each
trigger, each step and each agent. jigs never picks one for it.

### Name each installation {#installation-names}

Each place an app is installed or connected, such as a GitHub account or a
Slack workspace, is an installation, and each needs an **installation name**:
the name factories use to say which installation they mean, such as
`github-acme` or `slack-support`. A name is lowercase letters, digits and
hyphens, starting with a letter, and no two installations in your Organization
share one.

The hub learns of some installations by itself, such as those a GitHub App
already had when you added it, so a new installation starts without a name.
The app's page shows it as **Needs a name**; enter one under **Installation
name** and save. You can rename one later, but every factory that uses the
old name then needs the new one.

An unnamed installation gives no factory a token, and its events start and
wake no runs. Once you name it, the events it received before then that a
factory has not yet collected carry the new name.

### Example: one Slack app per teammate {#example-per-person}

Alice and Bob each run their own factory against the same Slack workspace,
and each wants replies from their own bot. Each creates a
[Slack app](/guide/hub-slack), adds it to the hub and installs it in the
workspace. Alice names her installation `slack-alice` and assigns her app only
to her factory; Bob does the same with `slack-bob`.

Alice's factory uses that name in its triggers:

```ts
import { slack } from "@jigs-ai/jigs";

// In defineFactory's `triggers`.
const triggers = {
  "answer-questions": {
    workflow: "answer",
    source: slack.mentions({ installationName: "slack-alice", channels: ["C0123ABCD"] }),
  },
};
```

and in its steps:

```ts
import { postSlackMessage } from "#jigs/steps";

export async function reply(channel: string, threadTs: string, text: string) {
  await postSlackMessage({ installationName: "slack-alice", channel, threadTs, text });
}
```

Both bots see a message in a channel they share, but a trigger takes only
events from its own installation, so a message mentioning Alice's bot starts
one run, in Alice's factory.

### Check the factory {#doctor}

`pnpm exec jigs doctor`, in the factory, checks that it reaches the hub, then:

- that each installation name the factory uses, in its bindings, triggers and
  agents, is named and assigned to it;
- that each binding's installation reaches its repository;
- that every named installation assigned to it works: each Slack one granted
  the scopes jigs uses, each PagerDuty one can read incidents, and each Linear
  one has your [`linear.operator`](/guide/configuration#linear-operator) as a
  user.

It names what to fix in the hub when one fails.
