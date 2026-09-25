import type {
  Experimental_EvaluationModel,
  Experimental_EvaluationQuestion,
  generateText,
  LanguageModel,
  OutputInterface,
} from "ai";
import type { Check } from "../../../checks/catalog.ts";
import type {
  Harness,
  HarnessKind,
  ModelKind,
  ModelSource,
} from "../../../workflow/agents/harness-config.ts";
import type { AskJevOptions, JevAnswers, JevQuestions } from "../../../workflow/agents/jev.ts";
import type { AgentRequest, ModelRequest } from "../../../workflow/agents/plan.ts";
import type { AgentSessionRef, ModelGeneration } from "../../../workflow/agents/result.ts";
import type { RunMetadata } from "../../runtime/run-context.ts";

export type ExecutorGeneration = ModelGeneration & { output?: unknown };
export type DecisionGeneration<QUESTIONS extends JevQuestions = JevQuestions> = {
  answers: JevAnswers<QUESTIONS>;
};

export type EvaluationGeneration = {
  answers: Record<string, unknown>;
  providerMetadata?: Record<string, Record<string, unknown>> | null;
};
/** An agent request that runs in a worktree. */
export type RunRequest = Extract<AgentRequest, { cwd: string }>;
/** A harness to open in a worktree, resuming a session when one is given. */
export type HarnessTarget = {
  harness: Harness;
  cwd: string;
  resume?: AgentSessionRef | undefined;
};
export type DriverRequest =
  | AgentRequest
  | ModelRequest
  | AskJevOptions<JevQuestions>
  | HarnessTarget;

export interface OpenContext {
  metadata: RunMetadata;
  env: Record<string, string>;
}

/** A live provider model and what closing it releases. */
export interface OpenedModel {
  model: LanguageModel;
  close(): Promise<void>;
}

/**
 * The AI SDK calls a driver makes through jigs rather than importing them, so a
 * test can replace them. A factory reads it only to see what a driver may reach.
 */
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

/**
 * What a driver receives for one call: the run it belongs to, the AI SDK calls
 * it may make, the harness environment jigs built for it, and, for a structured
 * call, the output spec a provider model consumes.
 */
export interface DriverContext {
  metadata: RunMetadata;
  deps: DriverDependencies;
  env: Record<string, string>;
  output?: OutputInterface<unknown, unknown, never>;
}

/**
 * How jigs runs one harness or model-source kind: its checks, the environment
 * it may see, and how it asks, runs or opens a provider model. Each kind a
 * descriptor can name has exactly one driver inside jigs; a factory cannot
 * register another.
 *
 * @remarks
 * A factory reads this to know what `createAgentRunner` does before it
 * hands back a model. The shape is a published contract: changing it is a
 * breaking release.
 */
export interface Driver<K extends HarnessKind | ModelKind> {
  kind: K;
  family: K extends HarnessKind ? "harness" : "model";
  ask?(request: AgentRequest | ModelRequest, context: DriverContext): Promise<ExecutorGeneration>;
  /** Build the live provider model for a run. Drivers without a provider model implement `run`. */
  open?(target: HarnessTarget, context: OpenContext): Promise<OpenedModel>;
  run?(request: RunRequest, context: DriverContext): Promise<ExecutorGeneration>;
  decide?<const QUESTIONS extends JevQuestions>(
    request: AskJevOptions<QUESTIONS>,
    context: DriverContext,
  ): Promise<DecisionGeneration<QUESTIONS>>;
  installationChecks(): Check[];
  descriptorChecks?(source: Extract<ModelSource, { kind: K }>): Check[];
  requestChecks(request: DriverRequest): Check[];
  jitChecks?(target: HarnessTarget): Check[];
  envAllowlist(request: DriverRequest): readonly string[];
  /** Names the driver sets in the harness environment itself, such as a private home. */
  setsEnv: readonly string[];
  sessionPointer?: { providerKey: string; field: string };
  displayName: string;
  resolveExecutable?(env: NodeJS.ProcessEnv): string;
  minimumVersion?: string;
}
