import type { generateText, LanguageModel, OutputInterface } from "ai";
import type { CodexAppServerProvider } from "ai-sdk-provider-codex-cli";
import type { HarnessKind, ModelKind, ModelSource } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest, ModelRequest } from "../../../blocks/agents/plan.ts";
import type { ModelGeneration } from "../../../blocks/agents/result.ts";
import type { Check } from "../../../checks/catalog.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";
import type { PiExecutionOptions } from "../harnesses/pi.ts";

export type ExecutorGeneration = ModelGeneration & { output?: unknown };

export interface DriverDependencies {
  generateText(options: {
    model: LanguageModel;
    prompt: string;
    system?: string;
    output?: OutputInterface<unknown, unknown, never>;
    providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
  }): Promise<ExecutorGeneration>;
  ensureCodexHome(runId: string): string;
  ensurePiHome(runId: string, source: ModelSource): string;
  executePi(options: PiExecutionOptions): Promise<ExecutorGeneration>;
  withCodexAppServer<T>(fn: (provider: CodexAppServerProvider) => Promise<T>): Promise<T>;
}

export interface DriverContext {
  metadata: RunMetadata;
  deps: DriverDependencies;
  env: Record<string, string>;
  output?: OutputInterface<unknown, unknown, never>;
}

export interface Driver<K extends HarnessKind | ModelKind> {
  kind: K;
  family: K extends HarnessKind ? "harness" : "model";
  ask?(request: AgentRequest | ModelRequest, context: DriverContext): Promise<ExecutorGeneration>;
  run?(request: AgentRequest, context: DriverContext): Promise<ExecutorGeneration>;
  decide?: undefined;
  runtimeChecks(request?: AgentRequest | ModelRequest): Check[];
  authChecks(request?: AgentRequest | ModelRequest): Check[];
  jitChecks?(request: AgentRequest): Check[];
  envAllowlist(request?: AgentRequest | ModelRequest): readonly string[];
  sessionPointer?: { providerKey: string; field: string };
  docsAnchor: string;
  displayName: string;
  resolveExecutable?(env: NodeJS.ProcessEnv): string;
  minimumVersion?: string;
  cost(generation: ExecutorGeneration): number | undefined;
}
