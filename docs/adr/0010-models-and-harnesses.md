# Model sources and harnesses have separate execution contracts

Status: accepted

Model sources are API endpoints; harnesses are agent programs jigs spawns.
Workflow code passes only tagged, serializable descriptors built with
`models.*` and `harnesses.*`. Step-side drivers in one registry
(`src/steps/agents/drivers`) turn a descriptor into a live provider and own its
execution, checks, environment and session pointers. `runAgent` and `askAgent`
take harnesses; `askModel` and `askJev` take model sources. Results report no
token usage or cost.

- **Claude Code and Codex** run through the community AI SDK providers
  (`ai-sdk-provider-claude-code`, `ai-sdk-provider-codex-cli`), exact-pinned,
  each a thin wrapper over the vendor's own runtime and its subscription login.
  They take a plain `cwd`, so an agent works directly in the run's worktree.
  Claude loads the worktree's project settings (`settingSources: ['project']`);
  Codex reads `AGENTS.md` and repo files. MCP is the exception
  ([0005](./0005-mcp-deny-by-default.md)).
- **Codex** runs on the provider's app-server surface, which supports resume.
  The provider is created per call and closed in `finally`, or the step
  process never exits.
- **Pi** runs as a subprocess of the installed binary; Pi owns its agent loop
  and jigs implements no `LanguageModel` for it. A result counts only after Pi
  emits `agent_settled`, the final assistant outcome succeeded and the process
  closed normally. Structured output goes only through an invocation-private
  `submit_result` tool that validates against the schema; the first accepted
  call stands, and a turn without one fails even if the reply is JSON.

## Consequences

- `askAgent` gives the model no tools: Claude with built-in tools off and no
  MCP, Pi with `--no-tools`. Codex is rejected because it has no tool-free mode,
  and a descriptor naming tools or MCP servers is rejected before any check.
- **The harness environment is built from empty.** It gets a short base set
  (`PATH`, `HOME`, user, shell, `TERM`, locale, `TZ`, `TMPDIR`, XDG dirs, proxy
  and CA settings), the driver's own variables and credential names, and the
  names the factory lists under `agents.env`. Nothing else from the service
  environment passes, whatever its name. `agents.env` is names only, applies to
  every harness and cannot name a model credential or a driver-set variable.
  Preflight, JIT checks and the service's probes use the same builder.
- Claude's environment is replaced at the provider's process-launch hook,
  where the driver also captures stderr so login failures still classify.
  Codex has no such hook, so the driver launches the app server through a
  per-invocation script that clears the environment.
- The allowlist isolates the environment, not the filesystem: agents run as the
  operator's user and can read what that user can.
- Retries are layered, not added: Pi's own request retries, the AI SDK's for
  direct model calls, and Workflow step replay. The drivers add no loop.
- Descriptors are reusable configuration, not sessions. Continuation happens
  only from an explicit session pointer validated before launch; only a missing
  or incompatible session permits a fresh-context rebuild.
- A descriptor kind with no registered driver fails explicitly at execution.
