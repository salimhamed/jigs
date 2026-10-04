import { generateText } from "ai";
import { expect, test } from "vitest";
import { getWorkflowMetadata } from "workflow";
import type { AgentSessionRef, Harness } from "../index.ts";
import { createAgentRunner } from "./index.ts";

// The guide's own agent step, minus its directive: this package carries none.
async function runWithTemperature(request: {
  harness: Harness;
  cwd: string;
  prompt: string;
  resume?: AgentSessionRef | undefined;
}) {
  const runner = await createAgentRunner(request.harness, {
    cwd: request.cwd,
    run: getWorkflowMetadata(),
    resume: request.resume,
  });
  try {
    const result = await generateText({
      model: runner.model,
      prompt: request.prompt,
      temperature: 0,
    });
    return { text: result.text, session: runner.sessionFrom(result) };
  } finally {
    await runner.close();
  }
}

test("the guide's own agent step compiles against the steps entry", () => {
  expect(runWithTemperature).toBeTypeOf("function");
});
