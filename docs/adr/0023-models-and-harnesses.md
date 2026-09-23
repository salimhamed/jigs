---
status: accepted
---

# Model sources and harnesses have separate execution contracts

Model sources are API endpoints. Harnesses are agent programs jigs spawns.
Workflow code passes only tagged serializable descriptors; step-side drivers
hydrate live providers and own execution, checks, environment allowlists and
session pointers. Results report no token usage or cost: jigs does not measure
or report model spend for any driver.

The public constructor namespaces are `models.*` and `harnesses.*`. The four
execution verbs state which family they accept: `runAgent` and `askAgent` take
harnesses; `askModel` and `askJev` take model sources.

## Consequences

- One step-side driver registry is the source of installed execution kinds.
- `askAgent` gives the model no tools. Claude Code runs with its built-in tools
  off and no MCP servers, Pi runs with `--no-tools`, and Codex is rejected
  because it has no tool-free mode. A descriptor that names tools or MCP servers
  is rejected before any check runs.
- Pi structured output goes only through an invocation-private `submit_result`
  tool, which validates the model's raw arguments against the requested
  schema. A structured ask allows only that tool; a structured run adds it to
  the caller's allowlist. The first accepted call stands. A turn that ends
  without one fails, even when the reply is JSON text, and a model or process
  failure after it still fails the call.
- Pi runs as a subprocess of the installed binary. jigs does not implement an
  AI SDK `LanguageModel` for it; Pi itself owns its agent loop. Pi's native
  request retries remain enabled, and jigs accepts a result only after Pi emits
  `agent_settled`, the final assistant outcome is successful, and the process
  closes normally. An earlier error that Pi recovers from does not poison the
  settled result.
- Pi's native retries, retries inside the AI SDK used by direct model calls,
  and Workflow step replay are separate layers. The Pi driver adds no retry
  loop of its own: exhausted Pi work rejects the step, after which Workflow
  decides whether to replay that whole durable operation. Stopping a running
  agent process remains part of the separate run-cancellation contract.
- Pi MCP support uses jigs' exact-pinned `pi-mcp-adapter`. Each run supplies a
  complete invocation-private configuration and named direct-tool allowlists;
  adapter proxy, scripting and ambient discovery surfaces remain disabled.
  The generated extension strips and blocks the adapter's temporary cache-miss
  proxy, disables resources, and starts stdio children from their declared
  environment plus the MCP SDK's small stdio default set, so they do not
  inherit Pi's model or sibling-server credentials.
  OAuth is permitted only through credentials already held by the adapter's
  secure store, and bearer secrets are resolved from named environment
  variables in step-side execution. Stdio environment entries and HTTP headers
  likewise map their target names to step-side source environment-variable
  names; literal secret values never enter the durable descriptor.
- Pi and its MCP children share a private process group. jigs stops the group
  when Pi exits, when the service shuts down, and when the process exits. Run
  cancellation does not yet reach a running Pi step.
- Subscription logins remain first-class for harnesses. A harness subprocess
  environment is built from empty, never inherited: a short base set every
  harness gets (`PATH`, `HOME`, user and shell, `TERM`, locale, `TZ`,
  `TMPDIR`, the XDG base directories, proxy and CA certificate settings);
  the driver's own variables, such as `CLAUDE_CONFIG_DIR` and the credential
  names its model source and MCP servers state; and the names the factory
  declares under `agents.env` in `jigs.config.ts`. Everything else in the
  service environment is omitted, whatever its name, so a database URL with
  an embedded password or a private key never reaches an agent unless it is
  declared. There is no pattern-based removal behind the allowlist.
  Environment-specific needs, such as a tool manager's variables or
  `SSH_AUTH_SOCK`, belong in the factory declaration, not in jigs' base set
  or a driver. Proxy URLs pass through unchanged, including any credentials
  written into them.
- The factory declaration is names only and applies to every harness the
  factory runs. It lives in factory configuration rather than on harness
  descriptors because these are properties of the host the service runs on:
  preflight checks and the service's own probes run before any descriptor
  exists, and recipes stay portable between factories. A step builds the
  environment once and hands the same map to its JIT checks and its harness;
  the service's CLI version probe and the Claude login probe use the same
  builder. The declaration cannot name a model credential or a variable a
  driver sets, since those would override the subscription login or the
  invocation's private home.
- The Claude driver replaces the child environment at the provider's
  process-launch hook, because the provider assembles its own from the host
  after accepting jigs'. At that seam the driver captures the CLI's stderr and
  hands it to the provider on the launch error, so login failures still
  classify as such. The Codex provider has no such hook and always launches
  the app server under the host environment plus jigs', so the driver
  launches it through a per-invocation script that clears the environment and
  keeps only the step's variables, referenced by name.
- The allowlist isolates the environment, not the filesystem. Agents run as
  the operator's user and can read any file that user can, including
  credential files and `.env` files on disk.
- Harness descriptors are reusable configuration, not mutable sessions.
  Generated settings and extensions belong to one invocation, while durable
  conversation files live separately. Continuation occurs only from an
  explicit, validated session pointer; unrelated execution failures never
  authorize a fresh-context fallback.
- The Pi and model-source descriptor types can exist before their drivers. An
  attempted execution fails explicitly with the unregistered kind.

This decision amends ADR 0004's statement that Pi is not a v0 harness.
