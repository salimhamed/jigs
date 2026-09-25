import { expect, test } from "vitest";
import { type ExecuteAgentStep, JitCheckError, runAgent } from "../../workflow/agents/agent.ts";
import { harnesses } from "../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../workflow/agents/plan.ts";
import { executeAgent } from "./execute-agent.ts";
import { factorylessDeps } from "./harnesses/test-fixtures.ts";

// Stands in for a factory's wrapper, minus the directive: it delegates to
// executeAgent the way a factory's own does.
const runStep: ExecuteAgentStep = (wire) =>
  executeAgent(wire, { workflowRunId: "run-under-test" }, factorylessDeps);

test("an agent step whose declared MCP server cannot start returns the JIT failure instead of throwing", async () => {
  const wire = buildAgentRequest({
    harness: harnesses.claude("sonnet", {
      mcpServers: {
        linear: {
          command: "definitely-not-a-binary",
          probe: { tool: "get_probe_token" },
        },
      },
    }),
    cwd: "/work/tree",
    prompt: "never reached — the JIT check fails first",
  });

  const result = await runStep(wire);

  expect(result).toMatchObject({
    jitFailure: [
      expect.objectContaining({
        label: expect.stringContaining("MCP server linear"),
        repair: expect.stringContaining("fix the 'linear' server"),
      }),
    ],
  });
});

test("runAgent() turns a failed JIT check into a thrown JitCheckError carrying the repair text", async () => {
  const failing = runAgent(
    {
      harness: harnesses.claude("sonnet", {
        mcpServers: {
          linear: {
            command: "definitely-not-a-binary",
            probe: { tool: "get_probe_token" },
          },
        },
      }),
      cwd: "/work/tree",
      prompt: "never reached — the JIT check fails first",
    },
    runStep,
  );
  await expect(failing).rejects.toThrow(JitCheckError);
  await expect(failing).rejects.toThrow(/MCP server linear/);
  // The repair travels as a field, so the caller writing it for a human never
  // parses it back out of the message.
  await expect(failing).rejects.toMatchObject({
    failures: [
      expect.objectContaining({
        repair: expect.stringContaining("fix the 'linear' server"),
      }),
    ],
  });
});
