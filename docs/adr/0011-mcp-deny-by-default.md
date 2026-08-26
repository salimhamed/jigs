# MCP deny-by-default: strict config on Claude, a managed Codex home

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
writes flow through to the single real file. Decided in
[AGE-294](https://linear.app/salboogie/issue/AGE-294/preflight-design),
verified against the Codex source at `rust-v0.149.1`.

## Consequences

- **A JIT guard fails any Codex step whose worktree carries a
  `.codex/config.toml` declaring `mcp_servers`**: `thread/start` auto-trusts
  a writable cwd (persisting trust), and project config can add servers even
  under the managed home — the guard is what makes deny-by-default hold.
- **Step-declared MCP servers must use non-interactive auth** (env-var keys,
  bearer tokens) in v0. A headless service cannot drive a browser OAuth
  dance, and no repair instruction fixes one mid-run. Interactive OAuth can
  return post-v0 with a token-broker design if the need appears.
- Codex's `config/mcpServer/reload` hot-refreshes servers into running
  threads by re-reading `config.toml` — under the managed home that file is
  the curated one, so the reload-into-live-threads race disarms itself.
- Empirical validations ride
  [AGE-305](https://linear.app/salboogie/issue/AGE-305/codex-app-server-resume-prototype)
  (already on the app-server surface): end-to-end isolation, symlinked auth
  surviving a refresh with the real login intact, and #16045's unverified
  claim that inline `-c` server definitions are ignored on 0.149.1 —
  load-bearing for the declared-list scheme, tested first.
- Amends ADR 0004's "skills/config reach agents through the worktree": MCP
  servers are the exception — declared per step, never repo-owned.

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
