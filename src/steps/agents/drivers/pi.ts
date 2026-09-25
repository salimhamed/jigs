import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harnessRuntimeCheck, piOpenaiCodexAuthCheck } from "../../../checks/harnesses.ts";
import { modelApiKeyCheck, openaiCompatibleRuntimeCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import type { PiHarness } from "../../../workflow/agents/harness-config.ts";
import type { AgentRequest } from "../../../workflow/agents/plan.ts";
import { MIN_PI_VERSION, resolvePiExecutable } from "../harnesses/executables.ts";
import type { PiExecutionOptions } from "../harnesses/pi.ts";
import { executePi } from "../harnesses/pi.ts";
import {
  piMcpEnvironmentVariables,
  piMcpToolNames,
  SUBMIT_RESULT_TOOL,
  validatePiMcpServers,
  writePiMcpExtension,
  writePiSubmitResultExtension,
} from "../harnesses/pi-extension.ts";
import {
  type PreparedPiHome,
  piSessionFile,
  preparePiInvocationHome,
} from "../harnesses/pi-home.ts";
import { type PiModelPlan, planPiModel } from "../harnesses/pi-model.ts";
import { AgentSessionError } from "../session-error.ts";
import type {
  Driver,
  DriverContext,
  DriverRequest,
  ExecutorGeneration,
  RunRequest,
} from "./types.ts";

function descriptor(request: AgentRequest): PiHarness {
  if (request.harness.kind !== "pi") throw new JigsError("the Pi driver requires a Pi request");
  return request.harness;
}

function modelName(plan: PiModelPlan): string {
  return `${plan.provider}/${plan.model}`;
}

function modelEnvironment(
  plan: PiModelPlan,
  env: Record<string, string>,
  preservedSources: ReadonlySet<string> = new Set(),
): Record<string, string> {
  if (plan.credential === undefined) return env;
  const value = env[plan.credential.sourceEnv];
  if (plan.credential.sourceEnv === plan.credential.targetEnv || value === undefined) return env;
  const translated = { ...env, [plan.credential.targetEnv]: value };
  if (!preservedSources.has(plan.credential.sourceEnv))
    delete translated[plan.credential.sourceEnv];
  return translated;
}

function promptFor(request: AgentRequest): string {
  const prompt =
    "system" in request && request.system !== undefined
      ? `${request.system}\n\n${request.prompt}`
      : request.prompt;
  if (request.outputSchema === undefined) return prompt;
  return `${prompt}\n\nCall ${SUBMIT_RESULT_TOOL} with the final answer.`;
}

export interface PiDriverDependencies {
  preparePiHome(runId: string, plan: PiModelPlan): PreparedPiHome;
  executePi(options: PiExecutionOptions): Promise<ExecutorGeneration>;
}

const defaultDependencies: PiDriverDependencies = {
  preparePiHome: (runId, source) => preparePiInvocationHome(runId, source),
  executePi,
};

export function createPiDriver(deps: PiDriverDependencies = defaultDependencies): Driver<"pi"> {
  async function ask(request: AgentRequest, context: DriverContext): Promise<ExecutorGeneration> {
    const harness = descriptor(request);
    const model = planPiModel(harness);
    const prepared = deps.preparePiHome(context.metadata.workflowRunId, model);
    let scratch: string | undefined;
    try {
      scratch = mkdtempSync(path.join(tmpdir(), "jigs-pi-ask-"));
      const { outputSchema } = request;
      const extension =
        outputSchema === undefined
          ? undefined
          : writePiSubmitResultExtension(prepared.home, outputSchema);
      const args = [
        "--mode",
        "json",
        // --no-tools would also drop extension tools, so a structured ask
        // allows exactly the result tool instead.
        ...(outputSchema === undefined ? ["--no-tools"] : ["--tools", SUBMIT_RESULT_TOOL]),
        "--model",
        modelName(model),
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
      return await deps.executePi({
        args,
        cwd: scratch,
        env: { ...modelEnvironment(model, context.env), PI_CODING_AGENT_DIR: prepared.home },
        requireResult: outputSchema !== undefined,
      });
    } finally {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      prepared.cleanup();
    }
  }

  async function run(request: RunRequest, context: DriverContext): Promise<ExecutorGeneration> {
    const harness = descriptor(request);
    const model = planPiModel(harness);
    const prepared = deps.preparePiHome(context.metadata.workflowRunId, model);
    const { resume } = request;
    const sessionId = resume?.id ?? `jigs-${randomUUID()}`;
    try {
      const sessionFile =
        resume === undefined ? undefined : piSessionFile(prepared.sessionDir, sessionId);
      if (resume !== undefined && sessionFile === undefined) {
        throw new AgentSessionError(
          `Pi session ${sessionId} is missing from ${prepared.sessionDir}`,
        );
      }
      const extension =
        request.outputSchema === undefined
          ? undefined
          : writePiSubmitResultExtension(prepared.home, request.outputSchema);
      const mcpExtension =
        harness.mcpServers === undefined || Object.keys(harness.mcpServers).length === 0
          ? undefined
          : writePiMcpExtension(prepared.home, harness.mcpServers);
      const selectedTools =
        harness.tools === undefined
          ? undefined
          : [
              ...new Set([
                ...harness.tools,
                ...piMcpToolNames(harness.mcpServers ?? {}),
                ...(request.outputSchema === undefined ? [] : [SUBMIT_RESULT_TOOL]),
              ]),
            ];
      const mcpEnvironment = new Set(piMcpEnvironmentVariables(harness.mcpServers ?? {}));
      const generation = await deps.executePi({
        args: [
          "--mode",
          "json",
          "--model",
          modelName(model),
          ...(harness.thinking === undefined ? [] : ["--thinking", harness.thinking]),
          ...(selectedTools === undefined ? [] : ["--tools", selectedTools.join(",")]),
          ...(sessionFile === undefined ? ["--session-id", sessionId] : ["--session", sessionFile]),
          "--session-dir",
          prepared.sessionDir,
          "-ne",
          "-ns",
          "-np",
          "--no-themes",
          "-nc",
          "--no-approve",
          ...(mcpExtension === undefined ? [] : ["-e", mcpExtension]),
          ...(extension === undefined ? [] : ["-e", extension]),
          promptFor(request),
        ],
        cwd: request.cwd,
        env: {
          ...modelEnvironment(model, context.env, mcpEnvironment),
          PI_CODING_AGENT_DIR: prepared.home,
        },
        requireResult: request.outputSchema !== undefined,
      });
      const reported = generation.providerMetadata?.pi?.sessionId;
      if (reported !== sessionId) {
        const message = `Pi reported session ${JSON.stringify(reported)} after jigs requested ${sessionId}`;
        throw new Error(message);
      }
      return generation;
    } finally {
      prepared.cleanup();
    }
  }

  function nestedHarness(request: DriverRequest): PiHarness | undefined {
    return "harness" in request && request.harness.kind === "pi" ? request.harness : undefined;
  }

  return {
    kind: "pi",
    family: "harness",
    ask,
    run,
    installationChecks: () => [harnessRuntimeCheck("pi")],
    requestChecks: (request) => {
      const harness = nestedHarness(request);
      if (harness === undefined) return [];
      if (harness.mcpServers !== undefined) validatePiMcpServers(harness.mcpServers);
      const model = planPiModel(harness);
      const mcpCredentials = piMcpEnvironmentVariables(harness.mcpServers ?? {});
      return [
        ...(model.runtimeSource === undefined
          ? []
          : [openaiCompatibleRuntimeCheck(model.runtimeSource)]),
        ...(model.credential === undefined ? [] : [modelApiKeyCheck(model.credential.sourceEnv)]),
        ...mcpCredentials.map((name) => modelApiKeyCheck(name)),
        ...(model.subscriptionAuth ? [piOpenaiCodexAuthCheck()] : []),
      ];
    },
    envAllowlist: (request: DriverRequest) => {
      const harness = nestedHarness(request);
      if (harness === undefined) return [];
      const credential = planPiModel(harness).credential;
      const servers = Object.values(harness.mcpServers ?? {});
      return [
        ...(credential === undefined ? [] : [credential.sourceEnv]),
        ...piMcpEnvironmentVariables(harness.mcpServers ?? {}),
        // The adapter's OAuth store is the OS keyring, which Linux reaches
        // over the session bus.
        ...(servers.some((server) => "auth" in server && server.auth === "oauth")
          ? ["DBUS_SESSION_BUS_ADDRESS"]
          : []),
      ];
    },
    sessionPointer: { providerKey: "pi", field: "sessionId" },
    docsAnchor: "pi",
    displayName: "Pi",
    resolveExecutable: resolvePiExecutable,
    minimumVersion: MIN_PI_VERSION,
  } satisfies Driver<"pi">;
}

export const piDriver = createPiDriver();
