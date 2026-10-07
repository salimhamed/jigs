# GitHub App

Factories act on GitHub as a GitHub App your [hub](/guide/hub) holds. Pull
requests come from `<app-slug>[bot]`, and you review them like anyone else's.
The hub receives the App's webhooks and mints a fresh installation token each
time a factory asks for one.

A GitHub App is not the hub's sign-in app. The hub uses two kinds of GitHub
app, and each has its own settings page and URLs:

| | Sign-in app | GitHub App (this page) |
| --- | --- | --- |
| What it does | Lets people sign in to the hub's web pages. | Lets factories act on GitHub, and sends the hub GitHub's webhooks. |
| Created under | **Developer settings → OAuth Apps** | **Developer settings → GitHub Apps** |
| Its credentials go | In the hub's environment. | Into the hub's web pages, under **Apps**. |
| URLs it needs | **Homepage URL** and **Redirect URI**, which the hub prints. | **Webhook URL** and **Setup URL**, which the App's page on the hub shows. |
| Set it up | [First sign-in](/guide/hub#first-sign-in) | Below |

You need to be an owner of the GitHub account or organization the App belongs
to, and an admin on the hub.

## 1. Create the App on GitHub

Under your organization's **Settings → Developer settings → GitHub Apps**, or
your own account's, choose **New GitHub App**. The form's sections, in order:

- **GitHub App name**: what people see on pull requests, such as
  `acme-jigs`.
- **Homepage URL**: your hub's address.
- **Identifying and authorizing users**: leave the **Callback URL** (also
  shown as **Redirect URI**) empty. Leave **Request user authorization
  (OAuth) during installation** and **Enable Device Flow** off. **Expire user
  authorization tokens** doesn't matter.
- **Post installation**: leave **Setup URL (optional)** empty for now; you set
  it in step 3, once the hub shows it. Turn on **Redirect on update**: it is
  off by default and easy to miss.
- **Webhook**: keep **Active** on. Set the **Webhook URL** to your hub's
  address followed by `/webhooks/github`, such as
  `https://hub.example.com/webhooks/github`. Set **Secret** to a long random
  string, such as one from `openssl rand -hex 32`, and keep it for step 2.
  Keep **SSL verification** enabled.
- **Permissions**, under **Repository permissions**:

  | Permission | Access | What factories use it for |
  | --- | --- | --- |
  | Contents | Read and write | Pushing branches and merging. |
  | Pull requests | Read and write | Opening, commenting on and merging pull requests. |
  | Issues | Read and write | Creating the `jigs:approved` label and commenting. |
  | Metadata | Read | Required by GitHub. |
  | Checks | Read | Reading CI. |
  | Commit statuses | Read | Reading CI. |

  Leave every other permission, in every section, at **No access**. Add one
  only when your own GitHub calls need it, such as **Members** read under
  Organization permissions to read teams.
- **Subscribe to events**: check **Pull request**, **Pull request review**,
  **Pull request review comment**, **Issue comment**, **Check suite** and
  **Status**. These wake the runs waiting on a pull request. The list is
  long, and **Status** is easy to miss: without it, factories miss CI that
  reports through commit statuses.
- **Where can this GitHub App be installed?**: **Only on this account**.
  Otherwise anyone can install it, and their events reach your factories.

Create the App. On its settings page, note the **App ID** and **Client ID**,
generate a **client secret**, and under **Private keys** generate a private
key, which downloads a `.pem` file. The App's **slug** is the last part of its
public page's URL, `https://github.com/apps/<slug>`.

## 2. Add the App to the hub

In the hub, under **Apps → Add app**, choose **GitHub App**. Enter a name for
the App on the hub, its slug, App ID, client ID, client secret, webhook
secret and the `.pem` file's contents. The hub checks the private key with
GitHub and records every installation the App already has.

The name only labels the App on the hub, and you can change it on the App's
page. The slug is what the hub installs the App and finds its bot user by,
and renaming the App on the hub never changes it.

## 3. Finish the App's settings

The App's page on the hub shows its **Webhook URL** and **Setup URL**. Back
in the App's settings on GitHub, set **Setup URL** to the one the hub shows,
which ends in `/setup/github/<id>`, make sure **Redirect on update** is on,
and check the Webhook URL matches.

## 4. Install the App

On the App's page on the hub, choose **Install on GitHub**, pick the account,
and choose its repositories. GitHub returns to the hub, which records the
installation; it then appears under **Installations**. Install it on every
account that owns a repository a factory binds.

Choosing **Only select repositories** keeps the App to the repositories your
factories bind. **All repositories** works too, but then every factory
assigned this App can reach every repository on that account, including ones
added later.

Each installation, including any the App already had, needs an
[installation name](/guide/hub#installation-names), such as `github-acme`.
Enter it under **Installation name** and save.

## 5. Assign it to factories

On the page of each factory that should act as this App, under **Assigned
apps**, choose the App and **Assign app**.

Each binding in a factory names the installation that reaches its repository
by its installation name. A factory may be assigned several Apps installed on
the same account, and uses the one each binding names.
`pnpm exec jigs doctor` in the factory checks each binding against the hub. A protected branch that restricts who can push
must list the App, or GitHub refuses its merges: see
[Merging](/guide/configuration#merging).
