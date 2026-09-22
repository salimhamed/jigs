import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSource, PiHarness } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../../../blocks/agents/plan.ts";
import { harnessRuntimeCheck, piAuthChecks } from "../../../checks/harnesses.ts";
import { openaiCompatibleRuntimeCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import { MIN_PI_VERSION, resolvePiExecutable } from "../harnesses/executables.ts";
import type { PiExecutionOptions } from "../harnesses/pi.ts";
import { executePi } from "../harnesses/pi.ts";
import { writePiSubmitResultExtension } from "../harnesses/pi-extension.ts";
import { ensureManagedPiHome, piSessionFile, piSessionsDir } from "../harnesses/pi-home.ts";
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

export interface PiDriverDependencies {
  ensurePiHome(runId: string, source: ModelSource): string;
  executePi(options: PiExecutionOptions): Promise<ExecutorGeneration>;
}

const defaultDependencies: PiDriverDependencies = {
  ensurePiHome: (runId, source) => ensureManagedPiHome(runId, source),
  executePi,
};

export function createPiDriver(deps: PiDriverDependencies = defaultDependencies): Driver<"pi"> {
  async function ask(request: AgentRequest, context: DriverContext): Promise<ExecutorGeneration> {
    const harness = descriptor(request);
    const scratch = mkdtempSync(path.join(tmpdir(), "jigs-pi-ask-"));
    try {
      const home = deps.ensurePiHome(context.metadata.workflowRunId, harness.model);
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
      const generation = await deps.executePi({
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

  async function run(request: AgentRequest, context: DriverContext): Promise<ExecutorGeneration> {
    const harness = descriptor(request);
    const home = deps.ensurePiHome(context.metadata.workflowRunId, harness.model);
    const sessionDir = piSessionsDir(home);
    const resume = "resume" in request ? request.resume : undefined;
    const sessionId = resume?.id ?? `jigs-${randomUUID()}`;
    if (resume !== undefined && piSessionFile(home, sessionId) === undefined) {
      throw new Error(`Pi session ${sessionId} is missing from ${sessionDir}`);
    }
    const extension =
      request.outputSchema === undefined
        ? undefined
        : writePiSubmitResultExtension(home, request.outputSchema);
    const generation = await deps.executePi({
      args: [
        "--mode",
        "json",
        "--model",
        modelName(harness.model),
        ...(harness.thinking === undefined ? [] : ["--thinking", harness.thinking]),
        ...(harness.tools === undefined ? [] : ["--tools", harness.tools.join(",")]),
        "--session-id",
        sessionId,
        "--session-dir",
        sessionDir,
        "-ne",
        "-ns",
        "-np",
        "--no-themes",
        "-nc",
        "--no-approve",
        ...(extension === undefined ? [] : ["-e", extension]),
        promptFor(request),
      ],
      cwd: request.cwd as string,
      env: { ...context.env, PI_CODING_AGENT_DIR: home },
    });
    const reported = generation.providerMetadata?.pi?.sessionId;
    if (reported !== sessionId) {
      throw new Error(
        `Pi reported session ${JSON.stringify(reported)} after jigs requested ${sessionId}`,
      );
    }
    if (request.outputSchema === undefined || generation.output !== undefined) return generation;
    return { ...generation, output: parseJsonFallback(generation.text) };
  }

  function nestedSource(request?: AgentRequest): ModelSource | undefined {
    return request?.harness.kind === "pi" ? request.harness.model : undefined;
  }

  return {
    kind: "pi",
    family: "harness",
    ask,
    run,
    installationChecks: () => [harnessRuntimeCheck("pi")],
    requestChecks: (request) => {
      const source = nestedSource(request as AgentRequest);
      return [
        ...(source?.kind === "openai-compatible" ? [openaiCompatibleRuntimeCheck(source)] : []),
        ...piAuthChecks(source),
      ];
    },
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
  } satisfies Driver<"pi">;
}

export const piDriver = createPiDriver();
