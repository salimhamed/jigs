import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expectTypeOf, test } from "vitest";
import type { AgentSessionRef } from "../index.ts";
import type { AgentRunner, AgentRunnerOptions, RunMetadata } from "./index.ts";

// A type-level snapshot of the published agent runner contract. Editing one of
// these assertions is a breaking release.

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];
type ProviderMetadata = Record<string, Record<string, unknown>> | null;

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

test("AgentRunnerOptions keeps its published shape", () => {
  expectTypeOf<AgentRunnerOptions>().toEqualTypeOf<{
    cwd: string;
    run: RunMetadata;
    resume?: AgentSessionRef | undefined;
  }>();
  expectTypeOf<RunMetadata>().toEqualTypeOf<{ workflowRunId: string }>();
});
