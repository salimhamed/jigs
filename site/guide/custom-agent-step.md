# Write your own agent step

Most workflows never need more than `runAgent` and a harness descriptor. When
one does, it writes its own step, the way it writes any step, and asks jigs for
the assembled runner instead of rebuilding the setup by hand.

## The runner

`createAgentRunner` opens a Claude Code or Codex harness the way the built-in
agent step does, and hands back the live provider model.

```ts
import { createAgentRunner } from "@jigs-ai/jigs/steps";

interface AgentRunner {
  model: LanguageModel;
  sessionFrom(result: GenerateTextResult): AgentSessionRef | undefined;
  close(): Promise<void>;
}

function createAgentRunner(
  harness: Harness,
  options: { cwd: string; run: RunMetadata; resume?: AgentSessionRef | undefined },
): Promise<AgentRunner>;
```

Before it returns, it does everything the built-in step does before it calls
the provider: it builds the agent's environment from the allowlist and your
`agents.env`, runs the request and just-in-time checks, locks the worktree,
gives Codex a private home and its own app server, and installs the Claude
launch hook. `model` is ready to pass to the AI SDK. `close` releases the lock
and stops what the harness started.

## A step that uses it

Put the step in the workflow's own `steps.ts`. The step file needs the AI SDK,
so add it to the factory: `pnpm add ai@7`.

```ts
// workflows/my-flow/steps.ts
import type { AgentSessionRef, Harness } from "@jigs-ai/jigs";
import { createAgentRunner } from "@jigs-ai/jigs/steps";
import { generateText } from "ai";
import { getWorkflowMetadata } from "workflow";

export async function runWithTemperature(request: {
  harness: Harness;
  cwd: string;
  prompt: string;
  resume?: AgentSessionRef | undefined;
}) {
  "use step";
  const runner = await createAgentRunner(request.harness, {
    cwd: request.cwd,
    run: getWorkflowMetadata(),
    resume: request.resume,
  });
  try {
    const result = await generateText({ model: runner.model, prompt: request.prompt, temperature: 0 });
    return { text: result.text, session: runner.sessionFrom(result) };
  } finally {
    await runner.close();
  }
}
```

The workflow calls it like any step, with a descriptor from its `agents`:

```ts
const answer = await runWithTemperature({
  harness: agents.builder,
  cwd: worktree.path,
  prompt: "Explain the failing test.",
});
```

Always close the runner in a `finally`. Until it is closed, no other agent can
start in that worktree.

## Where functions go

A step is the one place a factory can hand the provider a function, such as a
tool-approval hook or a logger. A descriptor is data the workflow writes to the
database for the step to read, so it can hold no function. A step runs in a
worker, where functions are allowed, so pass them through the AI SDK call your
step makes.

## When it throws

`createAgentRunner` throws a `JitCheckError` when a just-in-time check fails,
such as an MCP server that does not answer its probe. It throws an
`AgentSessionError`, exported beside it, when `resume` names a session this
harness cannot resume: catch it and start again without `resume` if the step
can. The built-in step turns both into what `runAgent` and `agentSession`
expect; your step decides for itself.

Pi has no AI SDK provider model: jigs runs the Pi CLI and reads its output
directly. So `createAgentRunner` throws for a Pi descriptor. Run Pi with
`runAgent`.

## Why a runner and not a plugin

The alternative was to let a factory inject its own functions into jigs' step.
A step of your own needs no new idea: it reads like every other step in the
factory, and jigs' policy still applies, because the runner applies it. Adding
a new harness kind from a factory is not supported yet.
