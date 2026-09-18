import { expect, test } from "vitest";
import type { TicketClaim } from "../linear/claim.ts";
import type { Halt, HumanReply } from "../linear/halt-for-human.ts";
import { JitCheckError } from "./agent.ts";
import { type AgentOrHaltDeps, agentOrHalt } from "./agent-or-halt.ts";
import { claude } from "./harness-config.ts";

const claim = {
  issueId: "issue-1",
  identifier: "AGE-420",
  token: "linear:ticket:issue-1",
} as TicketClaim;

const config = {
  harness: claude({ model: "sonnet" }),
  cwd: "/work/tree",
  prompt: "implement it",
};

const reply: HumanReply = {
  commentId: "c1",
  body: "fixed the token",
  author: { id: "u1", name: "Dev" },
  createdAt: "2026-08-26T00:00:00.000Z",
};

const stepResult = { text: "done", output: undefined };

test("agentOrHalt posts the repair through haltForHuman and re-runs the step after the reply", async () => {
  const halts: Halt[] = [];
  let attempts = 0;
  const deps = {
    runAgent: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new JitCheckError([
          {
            ok: false,
            id: "mcp:linear",
            label: "MCP server linear",
            reason: "it did not start",
            repair: "fix the linear server",
          },
          {
            ok: false,
            id: "aws",
            label: "AWS credentials",
            reason: "the session expired",
            repair: "run: aws sso login --profile prod",
          },
        ]);
      }
      return stepResult;
    },
    haltForHuman: async (_claim: TicketClaim, halt: Halt) => {
      halts.push(halt);
      return reply;
    },
  } as unknown as AgentOrHaltDeps;

  const result = await agentOrHalt(claim, config, deps);

  // One plain line per failure, repair included, and any reply retries the
  // step: nobody is being asked to choose between options here.
  expect(halts).toEqual([
    {
      headline: "jigs could not start a step on **AGE-420** because a check failed.",
      where: "starting a step",
      notes: [
        "MCP server linear: it did not start. fix the linear server",
        "AWS credentials: the session expired. run: aws sso login --profile prod",
      ],
      onReply: "retry",
    },
  ]);
  // Two attempts, not a replayed memoized failure: the step re-ran from zero.
  expect(attempts).toBe(2);
  expect(result).toEqual(stepResult);
});

test("agentOrHalt rethrows a non-JIT step failure instead of halting", async () => {
  let halts = 0;
  const deps = {
    runAgent: async () => {
      throw new Error("the agent could not build the project");
    },
    haltForHuman: async () => {
      halts += 1;
      return reply;
    },
  } as unknown as AgentOrHaltDeps;

  await expect(agentOrHalt(claim, config, deps)).rejects.toThrow("could not build the project");
  expect(halts).toBe(0);
});
