import type {
  Experimental_EvaluationModel,
  Experimental_EvaluationQuestion,
  generateText,
  LanguageModel,
  OutputInterface,
} from "ai";
import type { Check } from "../../../checks/catalog.ts";
import type {
  HarnessKind,
  ModelKind,
  ModelSource,
} from "../../../workflow/agents/harness-config.ts";
import type { AskJevOptions, JevAnswers, JevQuestions } from "../../../workflow/agents/jev.ts";
import type { AgentRequest, ModelRequest } from "../../../workflow/agents/plan.ts";
import type { ModelGeneration } from "../../../workflow/agents/result.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";

export type ExecutorGeneration = ModelGeneration & { output?: unknown };
export type DecisionGeneration<QUESTIONS extends JevQuestions = JevQuestions> = {
  answers: JevAnswers<QUESTIONS>;
  providerMetadata?: Record<string, Record<string, unknown>> | null;
};

export type EvaluationGeneration = {
  answers: Record<string, unknown>;
  providerMetadata?: Record<string, Record<string, unknown>> | null;
};
/** An agent request that runs in a worktree. */
export type RunRequest = Extract<AgentRequest, { cwd: string }>;
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
  run?(request: RunRequest, context: DriverContext): Promise<ExecutorGeneration>;
  decide?<const QUESTIONS extends JevQuestions>(
    request: AskJevOptions<QUESTIONS>,
    context: DriverContext,
  ): Promise<DecisionGeneration<QUESTIONS>>;
  installationChecks(): Check[];
  descriptorChecks?(source: Extract<ModelSource, { kind: K }>): Check[];
  requestChecks(request: DriverRequest): Check[];
  jitChecks?(request: AgentRequest): Check[];
  envAllowlist(request: DriverRequest): readonly string[];
  sessionPointer?: { providerKey: string; field: string };
  docsAnchor: string;
  displayName: string;
  resolveExecutable?(env: NodeJS.ProcessEnv): string;
  minimumVersion?: string;
}
