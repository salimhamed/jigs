// The step side of askModel(): one model call with no worktree, no MCP universe and
// no session pointer. It shares the executor seam with ./execute-agent.ts so a
// test hydrating either wire stubs one set of deps.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AskWire } from "../../blocks/agents/plan.ts";
import { type StepResult, toStepResult } from "../../blocks/agents/result.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import {
  type ExecuteDeps,
  type ExecutorGeneration,
  outputSpec,
  realDeps,
} from "./execute-agent.ts";
import { codexExecStepSettings } from "./harnesses/codex.ts";
import { scrubbedEnv } from "./harnesses/env.ts";
import { resolveClaudeExecutable } from "./harnesses/executables.ts";
import { claudeCode, codexExec } from "./harnesses/index.ts";

/** Ask a model a question without giving it a worktree or tools. */
export async function executeModelRequest(
  wire: AskWire,
  metadata: RunMetadata,
  deps: ExecuteDeps = realDeps,
): Promise<StepResult> {
  const runId = metadata.workflowRunId;
  const harness = wire.harness;
  const env = scrubbedEnv();
  const output = outputSpec(wire.outputSchema);
  const request = {
    prompt: wire.prompt,
    ...(wire.system !== undefined ? { system: wire.system } : {}),
    ...(output !== undefined ? { output } : {}),
  };

  let generation: ExecutorGeneration;
  if (harness.kind === "claude") {
    generation = await deps.generateText({
      // Not claudeStepSettings: a plain model call loads no worktree
      // settings and sees no MCP universe at all.
      model: claudeCode(harness.model, {
        strictMcpConfig: true,
        mcpServers: {},
        settingSources: [],
        env,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      }),
      ...request,
    });
  } else {
    // codex exec needs a cwd even for a pure model call; a scratch tmp dir
    // keeps a read-only sandbox pointed away from anything real.
    const scratch = mkdtempSync(path.join(tmpdir(), "jigs-ask-"));
    try {
      generation = await deps.generateText({
        model: codexExec(
          harness.model,
          codexExecStepSettings({
            cwd: scratch,
            codexHome: deps.ensureCodexHome(runId),
            env,
            approvalMode: "never",
            sandboxMode: "read-only",
          }),
        ),
        ...request,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return toStepResult(generation, wire.outputSchema !== undefined ? generation.output : undefined);
}
