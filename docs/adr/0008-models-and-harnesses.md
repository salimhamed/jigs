# Model sources and harnesses have separate execution contracts

Status: accepted

Model sources are API endpoints; harnesses are agent programs jigs spawns.
Workflow code passes only tagged, serializable descriptors built with
`models.*` and `harnesses.*`. Step-side drivers (`src/steps/agents/drivers`)
turn a descriptor into a live provider and own its execution, checks,
environment and session references. `runAgent` and `askAgent` take harnesses;
`askModel` and `askJev` take model sources. `createAgentRunner` opens a Claude
Code or Codex harness through the same driver for a factory's own step.
`Driver`, `DriverContext`, `AgentRunner` and the types they reach are a
published contract whose change is a breaking release.

- **Claude Code and Codex** run through the community AI SDK providers,
  exact-pinned, each a thin wrapper over the vendor's own runtime and its
  subscription login. They take a plain `cwd`, so an agent works directly in
  the run's worktree and loads its project settings and `AGENTS.md`. MCP is
  the exception ([0005](./0005-mcp-deny-by-default.md)).
- **Pi** runs as a subprocess of the installed binary; Pi owns its agent loop
  and jigs implements no `LanguageModel` for it. Structured output goes only
  through an invocation-private `submit_result` tool that validates against
  the schema; a turn without an accepted call fails even if the reply is JSON.

## Consequences

- `askAgent` gives the model no tools. Codex is rejected there because it has
  no tool-free mode, and a descriptor naming tools or MCP servers is rejected
  before any check.
- **The harness environment is built from empty.** It gets a short base set
  (path, home, user, shell, terminal, locale, temp and XDG dirs, proxy and CA
  settings), the driver's own variables and credential names, and the names
  the factory lists under `agents.env`. Nothing else from the service
  environment passes. `agents.env` is names only and cannot name a model
  credential or a driver-set variable. Every harness probe uses the same
  builder.
- The allowlist isolates the environment, not the filesystem: agents run as the
  operator's user and can read what that user can.
- Retries are layered, not added: the harness's or AI SDK's own request
  retries, then Workflow step replay. The drivers add no loop.
- Descriptors are reusable configuration, not sessions. Continuation happens
  only from an explicit session reference validated before launch; only a
  missing or incompatible session permits a fresh-context rebuild.
