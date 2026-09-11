import { expect, test } from "vitest";
import type { TicketClaim } from "../ticket/claim.ts";
import type { HumanReply } from "../ticket/halt-for-human.ts";
import { JitCheckError } from "./agent.ts";
import { type AgentOrHaltDeps, agentOrHalt } from "./agent-or-halt.ts";
import { claude } from "./harness-config.ts";

const claim = {
  issueId: "issue-1",
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
  const reasons: string[] = [];
  let attempts = 0;
  const deps = {
    agent: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new JitCheckError(
          "MCP server linear: did not start\n  → fix the linear server",
        );
      }
      return stepResult;
    },
    haltForHuman: async (_claim: TicketClaim, reason: string) => {
      reasons.push(reason);
      return reply;
    },
  } as unknown as AgentOrHaltDeps;

  const result = await agentOrHalt(claim, config, deps);

  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain("fix the linear server");
  // Two attempts, not a replayed memoized failure: the step re-ran from zero.
  expect(attempts).toBe(2);
  expect(result).toEqual(stepResult);
});

test("agentOrHalt rethrows a non-JIT step failure instead of halting", async () => {
  let halts = 0;
  const deps = {
    agent: async () => {
      throw new Error("the agent could not build the project");
    },
    haltForHuman: async () => {
      halts += 1;
      return reply;
    },
  } as unknown as AgentOrHaltDeps;

  await expect(agentOrHalt(claim, config, deps)).rejects.toThrow(
    "could not build the project",
  );
  expect(halts).toBe(0);
});
