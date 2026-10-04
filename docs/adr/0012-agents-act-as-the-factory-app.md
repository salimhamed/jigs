# Agents act on GitHub as the factory's App

Status: accepted

A coding agent that maintains a pull request has to read comments, reply and push
fixes. Factories gave it the operator's own token and SSH key, so its replies,
pushes and commits all looked like the operator's. jigs could not tell the
agent's replies from the operator's comments, and it ignored the operator's
approvals, because under `any-commit` the builder's own approvals cannot count.
It also left the agent with the operator's full access.

So in App mode ([0009](./0009-factory-identity-per-provider.md)) a harness can
opt in with `github: true`, or `github: { owner }` for an agent that has no
checkout. The agent then acts as the App's bot:

- **The token** is the installation token jigs uses itself: the whole
  installation, with the App's permissions, freshly minted for each agent step
  and valid for one hour. It is not narrowed to repositories or permissions:
  narrowing adds a second minting path, and the token fails to mint whenever
  the App's grants change. Push and merge need the same permission anyway, so
  branch protection, not the token, keeps the agent from merging. The owner is
  the one that owns the agent's checkout.
- **`gh` and `git`.** `gh` reads the token. `git` reaches the owner's
  repositories on github.com over HTTPS with the token, through `GIT_CONFIG_*`
  variables set for the agent only; no setting is written into the repository.
  An App cannot push over SSH. The rewrite and the token cover only that owner,
  so another account's repositories, such as an SSH dependency, keep their
  transport.
- **Commits** are authored by `<slug>[bot]`, through `GIT_AUTHOR_*`. The
  committer and the signature stay the operator's own git configuration, so
  signed commits still show as Verified. The factory does not add a co-author
  line to agent commits.
- **`githubMcp()`** is an optional MCP server definition. It runs the local
  `github-mcp-server` with the same token and without the tools that need a
  user, which an installation token cannot satisfy. A harness can use it only
  when it has opted in.

The same opt-in extends to every provider whose credential jigs holds:
`linear: true` and `pagerduty: true` hand the agent the factory's own token, and
`linearMcp()` and `pagerdutyMcp()` reach each vendor's official server with it.
Slack has none, because its official server takes only user tokens and jigs
holds a bot token.

## Consequences

- Under `any-commit`, approvals from the operator count again. jigs ignores only
  bot approvals, and the `operator` exception is removed.
- The recipe's builder opts in. It skips comments that its App bot posts without
  a jigs marker, which are its own replies, so the rule that comments posted
  during a builder turn are the builder's own goes away. This recognizes the bot
  by author, an exception to recognizing posts by id
  ([0009](./0009-factory-identity-per-provider.md)). The exception holds because
  only agents that opted in act as the bot, and jigs always marks its own notes.
  A plain comment from a different jigs agent on the same pull request would be
  skipped too.
- An agent turn longer than an hour loses GitHub access partway through, and its
  next turn gets a fresh token. Refreshing during a turn waits for a real case.
- One `gh` token per step means one owner per step. Steps that span several
  owners wait for a real case.
- `github` is an error in token mode: no factory build sees the harness
  descriptors, so preflight fails a run whose workflow declares such an agent,
  and the agent's step fails before the agent starts. A token-mode factory
  still wires up its agent's GitHub access itself.
- The agent still runs as the operator's OS user and can read the operator's
  files, SSH key included. The token limits what the agent does as itself, not
  what it could find on disk. Isolation is separate, later work.
- Rejected:
  - lending the token to every agent, since an agent answering Slack questions
    would hold write access to every repository;
  - having the agent report the ids of comments it posted, which trusts the
    model to be accurate;
  - having jigs post the agent's replies, which takes the replies off the
    agent's own tools;
  - GitHub's hosted MCP server, whose support for installation tokens is not
    established.
