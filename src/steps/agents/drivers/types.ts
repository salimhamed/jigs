import type {
  Experimental_EvaluationModel,
  Experimental_EvaluationQuestion,
  generateText,
  LanguageModel,
  OutputInterface,
} from "ai";
import type { CodexAppServerProvider } from "ai-sdk-provider-codex-cli";
import type { HarnessKind, ModelKind, ModelSource } from "../../../blocks/agents/harness-config.ts";
import type {
  AskJevOptions,
  JevAnswers,
  JevQuestions,
  JevUsage,
} from "../../../blocks/agents/jev.ts";
import type { AgentRequest, ModelRequest } from "../../../blocks/agents/plan.ts";
import type { ModelGeneration } from "../../../blocks/agents/result.ts";
import type { Check } from "../../../checks/catalog.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";
import type { PiExecutionOptions } from "../harnesses/pi.ts";

export type ExecutorGeneration = ModelGeneration & { output?: unknown };
export type DecisionGeneration<QUESTIONS extends JevQuestions = JevQuestions> = {
  answers: JevAnswers<QUESTIONS>;
  usage: JevUsage;
  providerMetadata?: Record<string, Record<string, unknown>> | null;
};

export type EvaluationGeneration = {
  answers: Record<string, unknown>;
  usage: JevUsage;
  providerMetadata?: Record<string, Record<string, unknown>> | null;
};
export type DriverRequest = AgentRequest | ModelRequest | AskJevOptions<JevQuestions>;

export interface DriverDependencies {
  generateText(options: {
    model: LanguageModel;
    prompt: string;
    system?: string;
    output?: OutputInterface<unknown, unknown, never>;
    providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
  }): Promise<ExecutorGeneration>;
  evaluate<const QUESTIONS extends Record<string, Experimental_EvaluationQuestion>>(options: {
    model: Experimental_EvaluationModel;
    state: AskJevOptions<JevQuestions>["state"];
    questions: QUESTIONS;
  }): Promise<EvaluationGeneration>;
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
  decide?<const QUESTIONS extends JevQuestions>(
    request: AskJevOptions<QUESTIONS>,
    context: DriverContext,
  ): Promise<DecisionGeneration<QUESTIONS>>;
  runtimeChecks(request?: DriverRequest): Check[];
  authChecks(request?: DriverRequest): Check[];
  jitChecks?(request: AgentRequest): Check[];
  envAllowlist(request?: DriverRequest): readonly string[];
  sessionPointer?: { providerKey: string; field: string };
  docsAnchor: string;
  displayName: string;
  resolveExecutable?(env: NodeJS.ProcessEnv): string;
  minimumVersion?: string;
  cost(generation: ExecutorGeneration | DecisionGeneration): number | undefined;
}
