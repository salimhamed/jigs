# Community CLI providers drive the harnesses

jigs v0 drives coding-agent steps through the community AI SDK providers —
`ai-sdk-provider-claude-code` (wrapping Anthropic's official Claude Agent SDK)
and `ai-sdk-provider-codex-cli` (wrapping the official `codex` CLI) — not the
`@ai-sdk/harness` family that ADR 0001 assumed.

The deciding question was subscription auth (Claude on a claude.ai login,
Codex on a ChatGPT login — a hard requirement, since API-metered agent steps
change the factory's economics). Probed empirically with every API-key env var
stripped (AGE-302; `prototype/harness-substrate` branch): **both** substrates
pass — the harness adapters inject no credentials when the env has none, and
the bridge-hosted vendor SDK falls back to its on-disk login. Auth therefore
didn't discriminate, and the rest of the ledger is lopsided:

- The harness path requires a custom `HarnessV1SandboxProvider` (the `sandbox`
  setting is required and no first-party local-directory provider exists), a
  per-session `pnpm install` bridge bootstrap (which aborted twice on host
  pnpm policy during the probes), and HOME/credential juggling to use
  framework skills without either polluting the real home directory or losing
  the on-disk logins. All of that buys cross-process live-session resume —
  which ADR 0003's model (steps memoized by key; suspensions only between
  steps) never uses. The harness's subscription auth is also fallback-by-
  accident, not a designed mode, so any adapter release that fails fast on
  missing credentials would break it.
- The CLI providers take a plain `cwd`, need no sandbox provider and no
  bootstrap, do native structured output (`Output.object` / `generateObject`),
  and are marked Stable against AI SDK v7. Skills and config reach the agent
  through the worktree itself — `.claude/skills` + `CLAUDE.md` via
  `settingSources: ['project']` for Claude Code; `AGENTS.md` and repo files
  for Codex — which matches jigs' repo-owned-config model.

## Consequences

- `jigs/harnesses` stays the single pin/wrap point (ADR 0001), now
  re-exporting the community providers. Both are single-maintainer
  (ben-vargas); exact pinning and the re-export seam contain that risk, and
  each is a thin wrapper over an official vendor runtime, which is the
  fallback if either wrapper dies.
- **Pi is not a v0 harness**: it has no community provider, and its harness
  adapter throws on structured output anyway. Post-v0 concern.
- The **Sandbox** construct leaves the domain model: nothing sits between a
  harness and its worktree. An agent step passes the worktree path as `cwd`.
- AGE-286's findings (sandbox provider surface, lockstep pinning,
  cross-process resume) remain valid knowledge of the rejected path; its
  recommendations no longer bind v0.
- *Amendment (ADR 0009 / AGE-293)*: Codex agent steps that resume a builder
  session use the provider's **app-server** surface
  (`threadMode: 'persistent'`), not exec — validated end to end by AGE-305:
  subscription auth, cross-process resume via
  `providerOptions['codex-app-server'].threadId`, and structured output all
  hold. Stale threads fail fast, but on codex 0.149.1 as a raw
  `JsonRpcRequestError` (`no rollout found for thread id …`) that escapes the
  provider's documented wrapper — detect resume failure by shape (match both
  messages) or treat any resume failure as stale. The provider must be
  created per step and closed in `finally` (`createCodexAppServer()` /
  `provider.close()`), or the step process never exits.
- *Amendment (ADR 0011 / AGE-294)*: MCP servers are the exception to
  "config reaches the agent through the worktree" — they are deny-by-default
  and declared per step (`strictMcpConfig` on Claude Code, a managed Codex
  home on Codex); the worktree's `.mcp.json` and `.codex/config.toml` MCP
  tables are never honored.
