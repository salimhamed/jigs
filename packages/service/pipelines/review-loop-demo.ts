import { type AgentStepConfig, claude } from "jigs/steps";
import { z } from "zod";
import {
  type ReviewLoopDeps,
  realDeps,
  reviewLoop,
} from "../src/review-loop/loop";
import { parseOutput, ResumeFailedError } from "../src/steps";
import { claimTicket } from "../src/suspension/claim";
import { needsHuman } from "../src/suspension/needs-human";
import { ticketReview } from "../src/ticket/review";
import { fetchSnapshot } from "../src/ticket/snapshot";
import { worktree } from "../src/worktrees";

export const reviewLoopDemoInputs = z.object({
  issueId: z.uuid(),
  binding: z.string().default("scratch"),
  merge: z.enum(["jigs", "human"]).default("jigs"),
  // `scripted` drives the whole shape end to end without burning agent turns,
  // the way ticket-review-demo's snapshot-only mode does.
  agents: z.enum(["live", "scripted"]).default("live"),
  // Scripted only: every resumed step fails, so the repro can exercise the
  // fresh-context fallback as the first-class path it is.
  staleResume: z.boolean().default(false),
});

type ReviewLoopDemoInputs = z.output<typeof reviewLoopDemoInputs> & {
  triggerId: string;
};

// Review-loop acceptance vehicle: claim the ticket, snapshot it, review it
// into a brief, then carry that brief to a merged pull request.
export async function reviewLoopDemoPipeline(inputs: ReviewLoopDemoInputs) {
  "use workflow";

  const claim = await claimTicket(inputs.issueId);
  const snapshot = await fetchSnapshot(inputs.issueId);
  const facts = await worktree({
    binding: inputs.binding,
    branch: snapshot.branchName,
  });
  console.log(
    `[review-loop-demo] ${snapshot.identifier} on ${facts.branch} at ${facts.path}`,
  );

  const deps =
    inputs.agents === "live"
      ? realDeps
      : scriptedDeps(inputs.staleResume, inputs.binding);

  const review = await ticketReview(
    {
      claim,
      snapshot,
      harness: claude({ model: "sonnet" }),
      cwd: facts.path,
    },
    { agent: deps.agent, needsHuman },
  );

  const result = await reviewLoop(
    {
      claim,
      handoff: review,
      harness: claude({ model: "sonnet" }),
      worktree: facts,
      binding: inputs.binding,
      merge: inputs.merge,
    },
    deps,
  );

  return { pr: result.pr, cycles: result.cycles };
}

function scriptedDeps(staleResume: boolean, binding: string): ReviewLoopDeps {
  return {
    ...realDeps,
    agent: (async <T>(config: AgentStepConfig<T>) => {
      if (staleResume && config.resume !== undefined) {
        throw new ResumeFailedError("scripted stale session");
      }
      const canned = await scriptedAgentStep(config.prompt, config.cwd);
      return {
        text: canned.text,
        output: parseOutput(config.output, canned.output),
        files: [],
        usage: undefined,
        session: { harness: "claude" as const, id: "scripted-session" },
      };
    }) as ReviewLoopDeps["agent"],
    // The scripted lane runs against a throwaway repo whose origin is a bare
    // directory, so there is no github.com remote to parse; the stubbed API
    // answers for any owner/repo.
    resolveRepo: async () => ({ owner: "jigs", repo: binding }),
  };
}

const ANSWER_RESUMED = "ANSWERED-BY-RESUMED-BUILDER";
const ANSWER_FRESH = "ANSWERED-BY-FRESH-CONTEXT";

// Canned agent turns selected by the prompt's own heading, plus the commits a
// real builder would have made — the push step reports an empty diff, and
// rightly refuses to open a PR for one.
async function scriptedAgentStep(
  prompt: string,
  cwd: string,
): Promise<{ text: string; output?: unknown }> {
  "use step";
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const path = await import("node:path");

  const commit = (file: string, body: string) => {
    writeFileSync(path.join(cwd, file), body);
    for (const args of [
      ["add", file],
      ["commit", "-q", "-m", `scripted: ${file}`],
    ]) {
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "jigs-scripted",
          GIT_AUTHOR_EMAIL: "scripted@jigs.test",
          GIT_COMMITTER_NAME: "jigs-scripted",
          GIT_COMMITTER_EMAIL: "scripted@jigs.test",
        },
      });
    }
  };
  const threadIds = [...prompt.matchAll(/^### Thread (\d+|null) /gm)].map(
    ([, id]) => (id === "null" ? null : Number(id)),
  );

  if (prompt.startsWith("# Ticket review")) {
    return {
      text: "",
      output: { verdict: "proceed", brief: "scripted brief", findings: [] },
    };
  }
  if (prompt.startsWith("# Implement")) {
    commit("scripted-work.txt", "the scripted builder was here\n");
    return { text: "implemented" };
  }
  if (prompt.startsWith("# Code review")) {
    return { text: "", output: { verdict: "approved", findings: [] } };
  }
  if (prompt.startsWith("# Fix CI")) {
    commit(`scripted-ci-fix-${Date.now()}.txt`, "fixed\n");
    return { text: "fixed" };
  }
  const body = prompt.startsWith("# Rebuild context")
    ? ANSWER_FRESH
    : ANSWER_RESUMED;
  console.log(`[review-loop-demo] scripted answer=${body}`);
  return {
    text: "",
    output: { answers: threadIds.map((threadId) => ({ threadId, body })) },
  };
}
