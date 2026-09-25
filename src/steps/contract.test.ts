import type { LanguageModel, OutputInterface } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expectTypeOf, test } from "vitest";
import type {
  AgentSessionRef,
  Harness,
  HarnessKind,
  ModelKind,
  OpenrouterSource,
} from "../index.ts";
import type { AskJevOptions, JevAnswers, JevQuestions } from "../workflow/agents/jev.ts";
import type { AgentRequest, ModelRequest } from "../workflow/agents/plan.ts";
import type {
  AgentRunner,
  Check,
  CheckResult,
  DecisionGeneration,
  Driver,
  DriverContext,
  DriverRequest,
  ExecutorGeneration,
  HarnessTarget,
  OpenContext,
  OpenedModel,
  RunMetadata,
  RunRequest,
} from "./index.ts";

// A type-level snapshot of the published driver contract. Editing one of these
// assertions is a breaking release. DriverContext.deps is jigs' own wiring and
// is deliberately left unpinned.

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];
type Method<T, K extends keyof T> = NonNullable<T[K]>;
type ProviderMetadata = Record<string, Record<string, unknown>> | null;

test("Driver keeps its published members", () => {
  expectTypeOf<keyof Driver<"claude">>().toEqualTypeOf<
    | "kind"
    | "family"
    | "ask"
    | "open"
    | "run"
    | "decide"
    | "installationChecks"
    | "descriptorChecks"
    | "requestChecks"
    | "jitChecks"
    | "envAllowlist"
    | "setsEnv"
    | "sessionPointer"
    | "displayName"
    | "resolveExecutable"
    | "minimumVersion"
  >();
  expectTypeOf<RequiredKeys<Driver<"claude">>>().toEqualTypeOf<
    | "kind"
    | "family"
    | "installationChecks"
    | "requestChecks"
    | "envAllowlist"
    | "setsEnv"
    | "displayName"
  >();
  expectTypeOf<Driver<HarnessKind>["kind"]>().toEqualTypeOf<HarnessKind>();
  expectTypeOf<Driver<"claude">["family"]>().toEqualTypeOf<"harness">();
  expectTypeOf<Driver<ModelKind>["family"]>().toEqualTypeOf<"model">();
  expectTypeOf<Driver<"claude">["setsEnv"]>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<Driver<"claude">["displayName"]>().toEqualTypeOf<string>();
  expectTypeOf<Driver<"claude">["sessionPointer"]>().toEqualTypeOf<
    { providerKey: string; field: string } | undefined
  >();
  expectTypeOf<Driver<"claude">["minimumVersion"]>().toEqualTypeOf<string | undefined>();
});

test("Driver keeps its published method signatures", () => {
  type D = Driver<"claude">;
  expectTypeOf<Parameters<Method<D, "ask">>>().toEqualTypeOf<
    [request: AgentRequest | ModelRequest, context: DriverContext]
  >();
  expectTypeOf<ReturnType<Method<D, "ask">>>().toEqualTypeOf<Promise<ExecutorGeneration>>();
  expectTypeOf<Parameters<Method<D, "open">>>().toEqualTypeOf<
    [target: HarnessTarget, context: OpenContext]
  >();
  expectTypeOf<ReturnType<Method<D, "open">>>().toEqualTypeOf<Promise<OpenedModel>>();
  expectTypeOf<Parameters<Method<D, "run">>>().toEqualTypeOf<
    [request: RunRequest, context: DriverContext]
  >();
  expectTypeOf<ReturnType<Method<D, "run">>>().toEqualTypeOf<Promise<ExecutorGeneration>>();
  expectTypeOf<Parameters<Method<D, "decide">>>().toEqualTypeOf<
    [request: AskJevOptions<JevQuestions>, context: DriverContext]
  >();
  expectTypeOf<ReturnType<Method<D, "decide">>>().toEqualTypeOf<
    Promise<DecisionGeneration<JevQuestions>>
  >();
  expectTypeOf<Parameters<Method<D, "installationChecks">>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<Method<D, "installationChecks">>>().toEqualTypeOf<Check[]>();
  expectTypeOf<Parameters<Method<Driver<"openrouter">, "descriptorChecks">>>().toEqualTypeOf<
    [source: OpenrouterSource]
  >();
  expectTypeOf<ReturnType<Method<Driver<"openrouter">, "descriptorChecks">>>().toEqualTypeOf<
    Check[]
  >();
  expectTypeOf<Parameters<Method<D, "requestChecks">>>().toEqualTypeOf<[request: DriverRequest]>();
  expectTypeOf<ReturnType<Method<D, "requestChecks">>>().toEqualTypeOf<Check[]>();
  expectTypeOf<Parameters<Method<D, "jitChecks">>>().toEqualTypeOf<[target: HarnessTarget]>();
  expectTypeOf<ReturnType<Method<D, "jitChecks">>>().toEqualTypeOf<Check[]>();
  expectTypeOf<Parameters<Method<D, "envAllowlist">>>().toEqualTypeOf<[request: DriverRequest]>();
  expectTypeOf<ReturnType<Method<D, "envAllowlist">>>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<Parameters<Method<D, "resolveExecutable">>>().toEqualTypeOf<
    [env: NodeJS.ProcessEnv]
  >();
  expectTypeOf<ReturnType<Method<D, "resolveExecutable">>>().toEqualTypeOf<string>();

  const driver = {
    kind: "claude",
    family: "harness",
    open: async () => ({ model: new MockLanguageModelV4(), close: async () => {} }),
    installationChecks: () => [],
    requestChecks: () => [],
    envAllowlist: () => [],
    setsEnv: [],
    sessionPointer: { providerKey: "claude-code", field: "sessionId" },
    displayName: "Claude Code",
  } satisfies Driver<"claude">;
  expectTypeOf(driver).toExtend<Driver<"claude">>();
});

test("the types a driver reaches keep their published shapes", () => {
  expectTypeOf<Check>().toEqualTypeOf<{
    id: string;
    label: string;
    run(): Promise<CheckResult>;
  }>();
  expectTypeOf<CheckResult>().toEqualTypeOf<
    { ok: true; detail?: string } | { ok: false; reason: string; repair: string }
  >();
  expectTypeOf<DriverRequest>().toEqualTypeOf<
    AgentRequest | ModelRequest | AskJevOptions<JevQuestions> | HarnessTarget
  >();
  expectTypeOf<RunRequest>().toEqualTypeOf<Extract<AgentRequest, { cwd: string }>>();
  expectTypeOf<HarnessTarget>().toEqualTypeOf<{
    harness: Harness;
    cwd: string;
    resume?: AgentSessionRef | undefined;
  }>();
  expectTypeOf<OpenContext>().toEqualTypeOf<{
    metadata: RunMetadata;
    env: Record<string, string>;
  }>();
  expectTypeOf<OpenedModel>().toEqualTypeOf<{ model: LanguageModel; close(): Promise<void> }>();
  expectTypeOf<ExecutorGeneration>().toEqualTypeOf<
    { text: string; providerMetadata?: ProviderMetadata } & { output?: unknown }
  >();
  expectTypeOf<DecisionGeneration<JevQuestions>>().toEqualTypeOf<{
    answers: JevAnswers<JevQuestions>;
  }>();
  expectTypeOf<RunMetadata>().toEqualTypeOf<{ workflowRunId: string }>();
});

test("DriverContext keeps its published shape", () => {
  expectTypeOf<keyof DriverContext>().toEqualTypeOf<"metadata" | "deps" | "env" | "output">();
  expectTypeOf<RequiredKeys<DriverContext>>().toEqualTypeOf<"metadata" | "deps" | "env">();
  expectTypeOf<DriverContext["metadata"]>().toEqualTypeOf<RunMetadata>();
  expectTypeOf<DriverContext["env"]>().toEqualTypeOf<Record<string, string>>();
  expectTypeOf<DriverContext["output"]>().toEqualTypeOf<
    OutputInterface<unknown, unknown, never> | undefined
  >();
});

test("AgentRunner keeps its published shape", () => {
  expectTypeOf<keyof AgentRunner>().toEqualTypeOf<"model" | "sessionFrom" | "close">();
  expectTypeOf<RequiredKeys<AgentRunner>>().toEqualTypeOf<"model" | "sessionFrom" | "close">();
  expectTypeOf<AgentRunner["model"]>().toEqualTypeOf<LanguageModel>();
  expectTypeOf<Parameters<AgentRunner["sessionFrom"]>>().toEqualTypeOf<
    [result: { providerMetadata?: ProviderMetadata | undefined }]
  >();
  expectTypeOf<ReturnType<AgentRunner["sessionFrom"]>>().toEqualTypeOf<
    AgentSessionRef | undefined
  >();
  expectTypeOf<Parameters<AgentRunner["close"]>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<AgentRunner["close"]>>().toEqualTypeOf<Promise<void>>();

  const runner = {
    model: new MockLanguageModelV4(),
    sessionFrom: () => undefined,
    close: async () => {},
  } satisfies AgentRunner;
  expectTypeOf(runner).toExtend<AgentRunner>();
});
