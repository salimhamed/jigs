# MCP deny-by-default across Claude, Codex and Pi

Status: accepted

An agent step's explicit `mcpServers` config is the entire MCP universe the
agent sees. Nothing is inherited from user-level config or from the worktree:
the factory's step config is the single source, so every harness sees the same
world from the same worktree.

- **Claude Code** runs with `strictMcpConfig: true`, which excludes user-scope
  and plugin servers, claude.ai connectors and the worktree's `.mcp.json`.
- **Codex** has no subtractive mechanism (config layers deep-merge), so each
  invocation runs under its own `CODEX_HOME`: a private, temporary directory
  holding a curated zero-server `config.toml`, `auth.json` **symlinked** to the
  real `~/.codex/auth.json`, and `sessions` linked to a durable per-run store.
  Symlink, never copy: refresh tokens are single-use, so two copies would
  invalidate each other, while Codex rewrites `auth.json` in place so the link
  survives. Parallel invocations cannot touch each other's settings, and
  removing the temporary home never removes conversation history.
- **Pi** loads a generated, invocation-private extension with `-e` that calls
  the exact-pinned `pi-mcp-adapter` with a complete config snapshot. Every
  server has a required named-tool allowlist; the adapter's generic proxy,
  namespace proxies, scripting, resources and host-config discovery are off,
  and Pi runs with its own extension, skill and project discovery disabled.
  The adapter's temporary cache-miss `mcp` proxy is removed before every model
  turn and blocked as a backstop.

## Consequences

- **A JIT guard fails any Codex step whose worktree has a `.codex/config.toml`
  declaring `mcp_servers`.** Codex trusts a writable cwd and project config can
  add servers even under the private home; the guard is what makes the default
  hold.
- **Step-declared servers use step-side credentials.** Environment entries,
  headers and bearer tokens name source environment variables; secrets never
  enter the durable descriptor. Pi stdio servers get only their declared
  environment plus the MCP SDK's stdio defaults, so model and sibling-server
  credentials do not cross. Pi HTTP servers may use OAuth only with credentials
  the adapter already holds; headless runs never start a login flow.
- MCP availability checks make a real tool call: agents misreport their own
  server list.
- Pi and its MCP children run in a private process group, stopped when Pi
  exits, when the service shuts down and when the process exits. `jigs cancel`
  does not yet reach a running Pi step.
- Rejected: disabling unwanted Codex servers one by one (a blocklist, blind to
  layers it cannot read and racy against hot reload), `codex exec
  --ignore-user-config` (the resume path runs on app-server, which has no
  equivalent), and asking operators to keep clean global configs.
