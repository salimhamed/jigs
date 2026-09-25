// The TypeScript examples in README.md beside this file, kept compiling by tsc.
// Each example below is the README block verbatim, wrapped only in what it
// needs in scope; the test fails when a README block is missing from here.

import { readFileSync } from "node:fs";
import {
  harnesses,
  type PullRequestRef,
  type PullRequestSnapshot,
  type TicketClaim,
  type TicketSnapshot,
} from "@jigs-ai/jigs";
import { expect, test } from "vitest";
import { z } from "zod";
import { agentSession, noteOnTicket } from "#jigs/routines";
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

// "The agents"
function theAgents() {
  const agents = {
    builder: harnesses.codex({ model: "gpt-5.6-sol" }),
    reviewer: harnesses.claude({ model: "opus" }),
    careful: harnesses.claude({ model: "opus", effort: "high" }),
  };
  const agentName = z.enum(["builder", "reviewer", "careful"]);
  return agents[agentName.parse("careful")];
}

// "The three phases"
async function theThreePhases() {
  const builder = agentSession({
    name: "builder",
    harness: delivery.builder,
    cwd: delivery.worktree.path,
  });

  try {
    const approved = await implementAndReview(delivery, builder);
    const pr = await publish(delivery, approved);
    await setTicketStatus(snapshot.id, "In Review");
    await followPullRequest(delivery, pr, builder);
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
  const maintenance = {
    resume: (pr: PullRequestRef, snapshot: PullRequestSnapshot) =>
      `Attend ${pr.owner}/${pr.repo}#${pr.number}. Read these facts and decide whether anything needs attention:\n${JSON.stringify(snapshot)}`,
    fresh: (task: WorkItem, pr: PullRequestRef, snapshot: PullRequestSnapshot) =>
      `${task.instructions}\n\n${maintenance.resume(pr, snapshot)}`,
  };
  return maintenance;
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
