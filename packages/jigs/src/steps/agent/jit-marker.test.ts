import { expect, test } from "vitest";
import type { RunAgentStep } from "../../blocks/agent/agent.ts";
import { agent, JitCheckError } from "../../blocks/agent/agent.ts";
import { claude } from "../../blocks/agent/harness-config.ts";
import { buildAgentWire } from "../../blocks/agent/plan.ts";
import { runAgent } from "./run-agent.ts";

// Stands in for a factory's wrapper, minus the directive: it delegates to
// runAgent the way a factory's own does.
const runStep: RunAgentStep = (wire) => runAgent(wire, "run-under-test");

test("an agent step whose declared MCP server cannot start returns the JIT failure instead of throwing", async () => {
  const wire = buildAgentWire({
    harness: claude({
      model: "sonnet",
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
    jitFailure: expect.stringContaining("MCP server linear"),
  });
  expect(result).toMatchObject({
    jitFailure: expect.stringContaining("→ fix the 'linear' server"),
  });
});

test("agent() turns a failed JIT check into a thrown JitCheckError carrying the repair text", async () => {
  const failing = agent(
    {
      harness: claude({
        model: "sonnet",
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
  await expect(failing).rejects.toThrow(/→ fix the 'linear' server/);
});
