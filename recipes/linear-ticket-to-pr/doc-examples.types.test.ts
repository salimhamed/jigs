// The TypeScript examples in README.md beside this file, kept compiling by tsc.
// Each example below is the README block verbatim, wrapped only in what it
// needs in scope; the test fails when a README block is missing from here.

import { readFileSync } from "node:fs";
import {
  type CheckRun,
  harnesses,
  models,
  type TicketClaim,
  type TicketSnapshot,
  type Worktree,
} from "@jigs-ai/jigs";
import { expect, test } from "vitest";
import { z } from "zod";
import { noteOnTicket } from "#jigs/routines";
import { setTicketStatus } from "#jigs/steps";
import {
  type Delivery,
  DeliveryStopped,
  followPullRequest,
  implementAndReview,
  publish,
  type WorkItem,
} from "./delivery/delivery.ts";

declare const delivery: Delivery;
declare const snapshot: TicketSnapshot;
declare const claim: TicketClaim;
declare const join: (parts: string[]) => string;
declare const taskBrief: (task: WorkItem, worktree: Worktree) => string;

// "The agents"
function theAgents() {
  const agents = {
    builder: harnesses.codex({ model: "gpt-5.6-sol" }),
    reviewer: harnesses.claude({ model: "opus" }),
    fixer: harnesses.pi(models.openaiCodex("gpt-5.5"), { thinking: "high" }),
    careful: harnesses.claude({ model: "opus", effort: "high" }),
  };
  const agentName = z.enum(["builder", "reviewer", "fixer", "careful"]);
  return agents[agentName.parse("careful")];
}

// "The three phases"
async function theThreePhases() {
  try {
    const approved = await implementAndReview(delivery);
    const pr = await publish(delivery, approved);
    await setTicketStatus(snapshot.id, "In Review");
    await followPullRequest(delivery, pr);
    await setTicketStatus(snapshot.id, "Done");
    return { pr: pr.url };
  } catch (error) {
    if (error instanceof DeliveryStopped) {
      await noteOnTicket(claim, error.note());
      await setTicketStatus(snapshot.id, "Todo");
    }
    throw error;
  }
}

// "Edit the prompts"
function editThePrompts() {
  const ciRepair = {
    job: "Investigate the failing checks, fix their cause, run relevant checks, and commit the fix. Do not push.",
    resume: (failing: CheckRun[]) =>
      join([`Failing checks:\n${JSON.stringify(failing)}`, ciRepair.job]),
    fresh: (task: WorkItem, worktree: Worktree, diff: string, failing: CheckRun[]) =>
      join([taskBrief(task, worktree), `Current diff:\n${diff}`, ciRepair.resume(failing)]),
  };
  return ciRepair;
}

const flatten = (code: string) =>
  code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");

test("every TypeScript example in the README is compiled here", () => {
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const here = flatten(readFileSync(new URL(import.meta.url), "utf8"));
  expect(blocks).toHaveLength(3);
  for (const block of blocks) {
    expect(here).toContain(flatten(block.replace("export const", "const")));
  }
  expect([theAgents, theThreePhases, editThePrompts]).toHaveLength(3);
});
