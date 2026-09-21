import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { OpenrouterSource } from "../../../blocks/agents/harness-config.ts";
import type {
  AskJevOptions,
  JevAnswer,
  JevAnswers,
  JevQuestion,
  JevQuestions,
} from "../../../blocks/agents/jev.ts";
import type { AgentRequest, ModelRequest } from "../../../blocks/agents/plan.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "../../../checks/core.ts";
import { modelApiKeyCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import type { DecisionGeneration, Driver, DriverContext, EvaluationGeneration } from "./types.ts";

type OpenRouterRequest = AgentRequest | ModelRequest | AskJevOptions<JevQuestions>;

const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

function descriptor(request?: OpenRouterRequest): OpenrouterSource | undefined {
  if (request === undefined || !("model" in request) || request.model.kind !== "openrouter")
    return undefined;
  return request.model;
}

function apiKeyEnv(request?: OpenRouterRequest): string {
  return descriptor(request)?.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
}

function isEligibleDecisionRequest(request: OpenRouterRequest | undefined): boolean {
  if (request === undefined || !("questions" in request)) return true;
  const source = descriptor(request);
  return (
    source !== undefined &&
    (source.model === "~typesafe/jev-latest" || source.model.startsWith("typesafe/jev-"))
  );
}

async function ask(request: AgentRequest | ModelRequest, context: DriverContext) {
  const source = descriptor(request);
  if (source === undefined)
    throw new JigsError("the OpenRouter driver requires an OpenRouter model request");
  const variable = source.apiKeyEnv;
  const apiKey = context.env[variable];
  if (apiKey === undefined || apiKey === "") {
    throw new JigsError(
      `${variable} is not set in the service's environment`,
      `set ${variable} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
    );
  }

  const openrouter = createOpenRouter({
    apiKey,
    headers: {
      "HTTP-Referer": "https://github.com/salimhamed/jigs",
      "X-Title": "jigs",
    },
  });
  return context.deps.generateText({
    model: openrouter(source.model),
    prompt: request.prompt,
    ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
    ...(context.output === undefined ? {} : { output: context.output }),
    providerOptions: { openrouter: { usage: { include: true } } },
  });
}

function evaluationQuestion(question: JevQuestion) {
  switch (question.type) {
    case "yes-no":
      return { type: "boolean" as const, instructions: question.instructions };
    case "choice":
      return {
        type: "choice" as const,
        instructions: question.instructions,
        criteria: question.options,
      };
    case "score":
      return {
        type: "score" as const,
        instructions: question.instructions,
        criteria: question.levels,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function malformedQuestion(key: string, detail: string): never {
  throw new JigsError(`question "${key}" is malformed: ${detail}`);
}

function invalidQuestion(error: unknown, questions: JevQuestions): never {
  const value = record(error);
  const detail = [value.argument, value.parameter, error instanceof Error ? error.message : error]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  const key = Object.keys(questions).find(
    (candidate) => detail.includes(`questions.${candidate}`) || detail.includes(`"${candidate}"`),
  );
  malformedQuestion(
    key ?? Object.keys(questions)[0] ?? "unknown",
    error instanceof Error ? error.message : String(error),
  );
}

function requiredRecord(value: unknown, key: string, field: string): Record<string, unknown> {
  if (!isRecord(value)) malformedQuestion(key, `${field} must be an object`);
  return value;
}

function probability(value: unknown, key: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    malformedQuestion(key, `${field} must be a number from 0 to 1`);
  return value;
}

function distribution(
  value: unknown,
  expectedKeys: readonly string[],
  key: string,
): Record<string, number> {
  const candidate = requiredRecord(value, key, "probabilities");
  return Object.fromEntries(
    expectedKeys.map((expected) => [
      expected,
      probability(candidate[expected], key, `probabilities.${expected}`),
    ]),
  );
}

function legend(value: unknown, expectedKeys: readonly string[], key: string) {
  const candidate = requiredRecord(value, key, "legend");
  return Object.fromEntries(
    expectedKeys.map((expected) => {
      const label = candidate[expected];
      if (typeof label !== "string" || label === "")
        malformedQuestion(key, `legend.${expected} must be a non-empty string`);
      return [expected, label];
    }),
  );
}

function normalizeAnswer<QUESTION extends JevQuestion>(
  key: string,
  question: QUESTION,
  rawAnswer: unknown,
  rawMetadata: unknown,
): JevAnswer<QUESTION> {
  // TypeScript cannot narrow a conditional generic by its discriminant; each assertion follows
  // complete runtime validation of the branch's public answer fields.
  const answer = requiredRecord(rawAnswer, key, "answer");
  if (question.type === "yes-no") {
    if (answer.type !== "boolean") malformedQuestion(key, "answer type must be boolean");
    const normalized = { probability: probability(answer.probability, key, "probability") };
    return normalized as JevAnswer<QUESTION>;
  }

  const metadata = requiredRecord(rawMetadata, key, "answer metadata");
  const confidence = probability(metadata.confidence, key, "confidence");
  if (question.type === "choice") {
    if (answer.type !== "choice") malformedQuestion(key, "answer type must be choice");
    const optionKeys = Object.keys(question.options);
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.options, answer.choice))
      malformedQuestion(key, "choice must name one of the question options");
    const normalized = {
      choice: answer.choice,
      probabilities: distribution(answer.probabilities, optionKeys, key),
      confidence,
    };
    return normalized as JevAnswer<QUESTION>;
  }

  if (answer.type !== "score") malformedQuestion(key, "answer type must be score");
  if (
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > question.levels.length - 1
  )
    malformedQuestion(key, "score must be within the question's level range");
  const levelKeys = question.levels.map((_, index) => String(index));
  const normalized = {
    score: answer.score,
    probabilities: distribution(answer.probabilities, levelKeys, key),
    confidence,
    legend: legend(metadata.legend, levelKeys, key),
  };
  return normalized as JevAnswer<QUESTION>;
}

function normalizeAnswers<const QUESTIONS extends JevQuestions>(
  questions: QUESTIONS,
  rawAnswers: Record<string, unknown>,
  rawMetadata: Record<string, unknown>,
): JevAnswers<QUESTIONS> {
  const entries = Object.entries(questions).map(([key, question]) => [
    key,
    normalizeAnswer(key, question, rawAnswers[key], rawMetadata[key]),
  ]);
  // Object iteration erases the mapped keys; normalizeAnswer validated every descriptor-specific field.
  return Object.fromEntries(entries) as JevAnswers<QUESTIONS>;
}

async function decide<const QUESTIONS extends JevQuestions>(
  request: AskJevOptions<QUESTIONS>,
  context: DriverContext,
): Promise<DecisionGeneration<QUESTIONS>> {
  const source = descriptor(request);
  if (source === undefined)
    throw new JigsError("the OpenRouter driver requires an OpenRouter decision request");
  if (!isEligibleDecisionRequest(request))
    throw new JigsError(
      `${source.model} is not a jev-class model; askJev accepts only jev-class models`,
    );
  const apiKey = context.env[source.apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new JigsError(
      `${source.apiKeyEnv} is not set in the service's environment`,
      `set ${source.apiKeyEnv} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
    );
  }
  const openrouter = createOpenRouter({
    apiKey,
    headers: { "HTTP-Referer": "https://github.com/salimhamed/jigs", "X-Title": "jigs" },
  });
  let evaluated: EvaluationGeneration;
  try {
    evaluated = await context.deps.evaluate({
      model: openrouter.evaluationModel(source.model),
      state: request.state,
      questions: Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => [
          key,
          evaluationQuestion(question),
        ]),
      ),
    });
  } catch (error) {
    if (record(error).name === "AI_InvalidArgumentError") invalidQuestion(error, request.questions);
    throw error;
  }

  const openrouterMetadata = record(evaluated.providerMetadata?.openrouter);
  const answerMetadata = record(openrouterMetadata.answers);
  const answers = normalizeAnswers(request.questions, evaluated.answers, answerMetadata);
  return { answers, usage: evaluated.usage, providerMetadata: evaluated.providerMetadata };
}

export const openrouterDriver = {
  kind: "openrouter",
  family: "model",
  ask,
  decide,
  runtimeChecks: () => [],
  authChecks: (request?: OpenRouterRequest) =>
    isEligibleDecisionRequest(request) ? [modelApiKeyCheck(apiKeyEnv(request))] : [],
  envAllowlist: (request?: OpenRouterRequest) => [apiKeyEnv(request)],
  docsAnchor: "openrouter",
  displayName: "OpenRouter",
  cost: (generation) => {
    const usage = generation.providerMetadata?.openrouter?.usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const cost = (usage as { cost?: unknown }).cost;
    return typeof cost === "number" ? cost : undefined;
  },
} satisfies Driver<"openrouter">;
