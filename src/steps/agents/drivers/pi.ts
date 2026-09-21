import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSource, PiHarness } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../../../blocks/agents/plan.ts";
import { harnessRuntimeCheck, piAuthChecks } from "../../../checks/harnesses.ts";
import { openaiCompatibleRuntimeCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import { MIN_PI_VERSION, resolvePiExecutable } from "../harnesses/executables.ts";
import { writePiSubmitResultExtension } from "../harnesses/pi-extension.ts";
import type { Driver, DriverContext, ExecutorGeneration } from "./types.ts";

function descriptor(request: AgentRequest): PiHarness {
  if (request.harness.kind !== "pi") throw new JigsError("the Pi driver requires a Pi request");
  return request.harness;
}

function modelName(source: ModelSource): string {
  if (source.kind === "openai-compatible") return `${source.name}/${source.model}`;
  return `${source.kind}/${source.model}`;
}

function promptFor(request: AgentRequest): string {
  const prompt =
    "system" in request && request.system !== undefined
      ? `${request.system}\n\n${request.prompt}`
      : request.prompt;
  if (request.outputSchema === undefined) return prompt;
  return `${prompt}\n\nCall submit_result with the final answer. If tool calls are unavailable, return only JSON matching this schema:\n${JSON.stringify(request.outputSchema)}`;
}

function parseJsonFallback(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

async function ask(request: AgentRequest, context: DriverContext): Promise<ExecutorGeneration> {
  const harness = descriptor(request);
  const scratch = mkdtempSync(path.join(tmpdir(), "jigs-pi-ask-"));
  try {
    const home = context.deps.ensurePiHome(context.metadata.workflowRunId, harness.model);
    const extension =
      request.outputSchema === undefined
        ? undefined
        : writePiSubmitResultExtension(home, request.outputSchema);
    const args = [
      "--mode",
      "json",
      "--no-tools",
      "--model",
      modelName(harness.model),
      ...(harness.thinking === undefined ? [] : ["--thinking", harness.thinking]),
      "-ne",
      "-ns",
      "-np",
      "--no-themes",
      "-nc",
      "--no-approve",
      ...(extension === undefined ? [] : ["-e", extension]),
      promptFor(request),
    ];
    const generation = await context.deps.executePi({
      args,
      cwd: scratch,
      env: { ...context.env, PI_CODING_AGENT_DIR: home },
    });
    if (request.outputSchema === undefined || generation.output !== undefined) return generation;
    // Pi is asked to call submit_result first. Some OpenAI-compatible servers do
    // not support tool calls, so only a turn with no call falls back to JSON text.
    return { ...generation, output: parseJsonFallback(generation.text) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function nestedSource(request?: AgentRequest): ModelSource | undefined {
  return request?.harness.kind === "pi" ? request.harness.model : undefined;
}

export const piDriver = {
  kind: "pi",
  family: "harness",
  ask,
  runtimeChecks: (request?: AgentRequest) => {
    const source = nestedSource(request as AgentRequest | undefined);
    return [
      harnessRuntimeCheck("pi"),
      ...(source?.kind === "openai-compatible" ? [openaiCompatibleRuntimeCheck(source)] : []),
    ];
  },
  authChecks: (request?: AgentRequest) => piAuthChecks(nestedSource(request)),
  envAllowlist: (request?: AgentRequest) => {
    const source = nestedSource(request as AgentRequest | undefined);
    if (source?.kind === "openrouter") return [source.apiKeyEnv];
    return source?.kind === "openai-compatible" && source.apiKeyEnv !== undefined
      ? [source.apiKeyEnv]
      : [];
  },
  sessionPointer: { providerKey: "pi", field: "sessionId" },
  docsAnchor: "pi",
  displayName: "Pi",
  resolveExecutable: resolvePiExecutable,
  minimumVersion: MIN_PI_VERSION,
  cost: (generation) => {
    const cost = generation.providerMetadata?.pi?.costUsd;
    return typeof cost === "number" ? cost : undefined;
  },
} satisfies Driver<"pi">;
