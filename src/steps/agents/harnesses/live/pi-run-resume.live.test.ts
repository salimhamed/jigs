import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { runAgent } from "../../../../blocks/agents/agent.ts";
import { harnesses, models } from "../../../../blocks/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../blocks/agents/plan.ts";
import type { AgentResult } from "../../../../blocks/agents/result.ts";
import { type DriverResolver, driverFor } from "../../drivers/index.ts";
import { createPiDriver } from "../../drivers/pi.ts";
import {
  type AgentExecutionDependencies,
  defaultAgentExecutionDependencies,
  executeAgent,
} from "../../execute-agent.ts";
import { executePi } from "../pi.ts";
import { piRunStatePath, piSessionsDir, preparePiInvocationHome } from "../pi-home.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { makeScratchRepo } from "./fixtures/live-env.ts";

const baseUrl = process.env.JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL;
const localModel = process.env.JIGS_TEST_OPENAI_COMPATIBLE_MODEL;
const localConfigured =
  baseUrl !== undefined && baseUrl !== "" && localModel !== undefined && localModel !== "";
const localReachable = localConfigured
  ? await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

let tmp: string;
let piHomes: string;
let deps: AgentExecutionDependencies;
beforeAll(() => {
  tmp = makeTmpDir();
  piHomes = path.join(tmp, "pi-homes");
  const pi = createPiDriver({
    preparePiHome: (runId, source) => preparePiInvocationHome(runId, source, { baseDir: piHomes }),
    executePi,
  });
  deps = {
    ...defaultAgentExecutionDependencies,
    resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
  };
});
afterAll(() => removeTmpDir(tmp));

function success(result: Awaited<ReturnType<typeof executeAgent>>): AgentResult<unknown> {
  if ("jitFailure" in result) throw new Error("unexpected JIT failure");
  if ("resumeFailed" in result)
    throw new Error(`unexpected resume failure: ${result.resumeFailed}`);
  return result;
}

test.skipIf(!localConfigured || !localReachable)(
  "Pi runs in a worktree, resumes in a new process, submits a structured run, and rejects a stale pointer",
  async () => {
    const worktree = makeScratchRepo(tmp, "pi-run-resume");
    const secret = `memory-${crypto.randomUUID()}`;
    const harness = harnesses.pi(
      models.openaiCompatible({
        name: "lmstudio",
        baseUrl: baseUrl as string,
        model: localModel as string,
      }),
    );
    const metadata = { workflowRunId: `live-pi-run-${crypto.randomUUID()}` };

    const first = success(
      await executeAgent(
        buildAgentRequest({
          harness,
          cwd: worktree,
          prompt: [
            `Remember this secret for the next turn: ${secret}.`,
            "Use a tool to create PI_RUN_PROOF.txt containing exactly created, then reply DONE.",
          ].join("\n"),
        }),
        metadata,
        deps,
      ),
    );
    expect(existsSync(path.join(worktree, "PI_RUN_PROOF.txt"))).toBe(true);
    expect(first.session).toMatchObject({ harness: "pi" });

    const runState = piRunStatePath(metadata.workflowRunId, { baseDir: piHomes });
    expect(readdirSync(path.join(runState, "invocations"))).toEqual([]);
    expect(readdirSync(piSessionsDir(runState)).length).toBe(1);

    const resultFile = path.join(tmp, "continued.json");
    await promisify(execFile)(
      process.execPath,
      [
        path.join(import.meta.dirname, "fixtures", "pi-continue.ts"),
        JSON.stringify({
          baseDir: piHomes,
          baseUrl,
          model: localModel,
          runId: metadata.workflowRunId,
          cwd: worktree,
          prompt: "Reply with exactly the secret I asked you to remember in the previous turn.",
          resume: first.session,
          resultFile,
        }),
      ],
      { timeout: 540_000 },
    );
    const resumed = success(JSON.parse(readFileSync(resultFile, "utf8")));
    expect(resumed.text).toContain(secret);
    expect(resumed.session).toEqual(first.session);
    expect(readdirSync(path.join(runState, "invocations"))).toEqual([]);

    const structured = await runAgent(
      {
        harness,
        cwd: worktree,
        prompt: "Read PI_RUN_PROOF.txt with a tool, then submit its file name and exact contents.",
        output: z.object({ file: z.string(), content: z.string() }),
      },
      (wire) => executeAgent(wire, metadata, deps),
    );
    expect(structured.output.file).toContain("PI_RUN_PROOF.txt");
    expect(structured.output.content.trim()).toBe("created");
    expect(structured.session?.id).not.toBe(first.session?.id);

    const stale = await executeAgent(
      buildAgentRequest({
        harness,
        cwd: worktree,
        prompt: "continue",
        resume: { harness: "pi", id: `missing-${crypto.randomUUID()}` },
      }),
      metadata,
      deps,
    );
    expect(stale).toHaveProperty("resumeFailed");
  },
);
