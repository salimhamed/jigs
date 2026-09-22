# MCP deny-by-default across Claude, Codex and Pi

An agent step's explicit `mcpServers` config is the entire MCP universe the
agent sees; nothing is inherited from user-level config (the dev machine's
`~/.claude.json` holds 40 user-scope servers, `~/.codex/config.toml` 33
tables — none may reach agents). On Claude Code this is a first-party flag:
`strictMcpConfig: true`, which excludes user-scope servers, plugin servers,
claude.ai connectors, and the worktree's `.mcp.json` — the last deliberately:
the factory repo's step config is the single MCP source, and repo-owned MCP
would make the two harnesses see different worlds from the same worktree. On
Codex **no subtractive mechanism exists** — config layers deep-merge
(`-c 'mcp_servers={}'` is a silent no-op, openai/codex #16045; profiles
cannot scope MCP; the app-server's per-thread `config` param rides the same
additive path) — so jigs builds the flag Codex lacks: every Codex step runs
under a **managed Codex home**, `CODEX_HOME` pointed at a jigs-owned
directory (via the provider's `env` option, both surfaces) holding a curated
zero-server `config.toml` and `auth.json` **symlinked** to the real
`~/.codex/auth.json`. Symlink, never copy: refresh tokens rotate one-time-use
so two copies fight to mutual invalidation, while `auth.json` writes are
in-place truncate (no rename), so the symlink survives every refresh and
writes flow through to the single real file. The generated configuration is
private to one invocation, so parallel calls cannot rewrite each other's
settings. Its `sessions` entry links to a separate durable per-run rollout
store, so removing temporary configuration cannot remove conversation history. Decided in
[AGE-294](https://linear.app/salboogie/issue/AGE-294/preflight-design),
verified against the Codex source at `rust-v0.149.1`.

Pi loads a generated invocation-private extension explicitly with `-e`. That
extension imports jigs' exact-pinned `pi-mcp-adapter` and calls
`createMcpAdapter({ config })`, whose `config` is a complete snapshot rather
than a file-discovery layer. Every declared server has a required named-tool
allowlist. The adapter exposes only those direct tools; its generic proxy,
per-server namespace proxies, scripting mode, Jev integration, Agent Plugin
paths, ancestor roots and host-config discovery are disabled. Pi still runs
with extension, skill, prompt-template, theme and project-approval discovery
disabled. The extension and its adapter runtime belong to one invocation, so
parallel invocations cannot share configuration or MCP children.

The adapter may temporarily register its generic `mcp` proxy while a direct
tool server has no metadata cache. The invocation extension removes that proxy
from the active tool set before every model turn and blocks the call as a
backstop. Server resources are disabled. Stdio servers do not inherit Pi's
environment; each receives only its declared environment, so model credentials
and sibling-server credentials cannot cross that process boundary.

## Consequences

- **A JIT guard fails any Codex step whose worktree carries a
  `.codex/config.toml` declaring `mcp_servers`**: `thread/start` auto-trusts
  a writable cwd (persisting trust), and project config can add servers even
  under the managed home — the guard is what makes deny-by-default hold.
- **Step-declared MCP servers use step-side credentials.** Pi stdio environment
  entries, HTTP headers and bearer descriptors name source environment
  variables; their secrets are allowlisted into the invocation environment and
  never enter the durable descriptor. Pi HTTP servers may
  select OAuth only when the adapter already has credentials in its secure
  store. Headless runs never start login flows. Claude and Codex keep their
  existing non-interactive-auth restriction.
- Codex's `config/mcpServer/reload` hot-refreshes servers into running
  threads by re-reading `config.toml` — under the managed home that file is
  the curated one, so the reload-into-live-threads race disarms itself.
- Empirical validations ran on
  [AGE-305](https://linear.app/salboogie/issue/AGE-305/codex-app-server-resume-prototype)
  and all passed on 0.149.1: **#16045 refuted** — declared-list
  `mcp_servers.*` overrides register and the declared server answers real
  tool calls; isolation held on both surfaces against a live control (the
  user's `qmd` callable from the real home, absent under the managed home);
  the auth symlink survived every run with the real login intact (no live
  token refresh was observed, so refresh survival still rests on the source
  verification); the auto-trust hole reproduced — the workspace server
  loaded and codex **prepended** a `[projects."<cwd>"] trust_level =
  "trusted"` record into the curated `config.toml`, confirming the JIT
  guard is load-bearing and the invocation home is Codex-mutable state.
- Rollouts live through `CODEX_HOME/sessions`, which links to durable per-run
  storage. A resume validates the exact rollout before Codex starts; only
  missing or incompatible session state permits a caller to rebuild context.
- MCP availability checks must exercise a real tool call: agents
  misreported their own MCP server list even when a server was demonstrably
  callable (AGE-305, probe 6).
- Pi's deterministic adapter test inspects the actual model request as well as
  invoking the stdio probe. This proves ambient servers and generic adapter
  tools are absent rather than merely unused, including when an explicit server
  fails and the adapter would otherwise retain its fallback proxy. OAuth probes
  run through Pi itself because a second raw MCP client cannot reuse
  adapter-owned secure credentials without becoming another integration path.
- Pi and its MCP descendants run in a private process group. An explicit
  execution abort and an unexpected Pi death both trigger bounded group cleanup.
  Workflow run cancellation still cannot supply an abort signal to an active
  step: the current World contract deliberately allows an in-flight effect to
  finish after `jigs cancel`. End-to-end prompt cancellation remains blocked on
  a Workflow cancellation signal reaching the executing step.
- Amends ADR 0004's "skills/config reach agents through the worktree": MCP
  servers are the exception — declared per step, never repo-owned.
- *Amendment (2026-09-22)*: "managed Codex home" is now an **invocation
  home** — private, temporary configuration per invocation — plus a durable
  per-run session store it links to.
- *Amendment (2026-09-22)*: Pi supports MCP only through an explicit
  `pi-mcp-adapter` snapshot. Pi never imports the user's global MCP file or the
  worktree's `.mcp.json` / `.pi/mcp.json`; a factory may read an operator-owned
  definition while constructing step-side configuration, but it must select
  and declare each server and tool itself.

## Considered options

- **Enumerate-and-disable** (read the user config, emit
  `mcp_servers.<name>.enabled=false` per unwanted server via
  `configOverrides`): the recorded **plan B** if the auth symlink misbehaves.
  Rejected as primary: it is a blocklist — blind to layers it cannot read
  (system `/etc/codex/config.toml`, plugins), racy against hot-reload, and
  more code per spawn than the home is once. The in-worktree
  `.codex/config.toml` variant additionally puts the allowlist inside the
  agent's writable workspace and mutates the user's real config via trust
  persistence.
- **`codex exec --ignore-user-config`**: real (source-verified, exec-only)
  and cleaner where it applies, but the builder-resume path lives on
  app-server, which has no equivalent, and the provider exposes no
  arbitrary-flag passthrough. Noted as a possible later simplification for
  exec-only steps.
- **Cleaning the user's global configs**: discipline, not enforcement —
  breaks silently on the next personal config edit and only works on
  machines whose owners keep clean homes.
