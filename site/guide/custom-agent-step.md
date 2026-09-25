# Custom agent steps

Most workflows should use `runAgent` and the built-in harness descriptors.
Write a custom agent step only when you need control that cannot be represented
as durable descriptor data.

## When you need one

- Pass a function, such as a logger or provider callback.
- Call the AI SDK directly.
- Set a generation option inside the step.
- Customize provider interaction while keeping jigs' runner policy.

Harness descriptors cross the durable workflow/step boundary, so they must be
JSON-serializable data. Functions and live provider objects cannot cross as
step inputs or results. A custom `"use step"` function creates and uses them
inside the worker. Ordinary pure functions are also allowed in workflow code;
see [Core concepts](/guide/concepts).

## The runner

`createAgentRunner` gives a custom step the same harness setup and policy used
by the built-in agent step. It handles environment policy, checks, worktree
locking, session setup and provider startup. The returned live provider model
can be passed to the AI SDK. See the [runner API](/api/steps#createagentrunner)
for the exact contract.

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

**Always close the runner in `finally`.** It holds resources such as the worktree
lock until it closes.

## Errors

`createAgentRunner` throws a `JitCheckError` when a just-in-time check fails,
such as an MCP server that does not answer its probe. It throws an
`AgentSessionError`, exported beside it, when `resume` names a session this
harness cannot resume: catch it and start again without `resume` if the step
can. The built-in step turns both into what `runAgent` and `agentSession`
expect; your step decides for itself.

Pi has no AI SDK provider model: jigs runs the Pi CLI and reads its output
directly. So `createAgentRunner` throws for a Pi descriptor. Run Pi with
`runAgent`.
