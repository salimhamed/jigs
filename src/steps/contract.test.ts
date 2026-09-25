import { MockLanguageModelV4 } from "ai/test";
import { expectTypeOf, test } from "vitest";
import type { AgentSessionRef } from "../index.ts";
import type { AgentRunner, Driver, DriverContext, DriverDependencies } from "./index.ts";

// A type-level snapshot of the published driver contract. Editing one of these
// lists is a breaking release.

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];

test("Driver keeps its published shape", () => {
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
  expectTypeOf<Driver<"claude">["family"]>().toEqualTypeOf<"harness">();
  expectTypeOf<Driver<"openrouter">["family"]>().toEqualTypeOf<"model">();
  expectTypeOf<Driver<"claude">["setsEnv"]>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<Driver<"claude">["sessionPointer"]>().toEqualTypeOf<
    { providerKey: string; field: string } | undefined
  >();
  expectTypeOf<Driver<"claude">["resolveExecutable"]>().toEqualTypeOf<
    ((env: NodeJS.ProcessEnv) => string) | undefined
  >();
  expectTypeOf<Driver<"claude">["minimumVersion"]>().toEqualTypeOf<string | undefined>();

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

test("DriverContext keeps its published shape", () => {
  expectTypeOf<keyof DriverContext>().toEqualTypeOf<"metadata" | "deps" | "env" | "output">();
  expectTypeOf<RequiredKeys<DriverContext>>().toEqualTypeOf<"metadata" | "deps" | "env">();
  expectTypeOf<DriverContext["env"]>().toEqualTypeOf<Record<string, string>>();
  expectTypeOf<DriverContext["deps"]>().toEqualTypeOf<DriverDependencies>();
});

test("DriverDependencies keeps its published shape", () => {
  expectTypeOf<keyof DriverDependencies>().toEqualTypeOf<"generateText" | "evaluate">();
  expectTypeOf<RequiredKeys<DriverDependencies>>().toEqualTypeOf<"generateText" | "evaluate">();
  expectTypeOf<Parameters<DriverDependencies["generateText"]>[0]>().toHaveProperty("model");
  expectTypeOf<Parameters<DriverDependencies["generateText"]>[0]>().toHaveProperty("prompt");
});

test("AgentRunner keeps its published shape", () => {
  expectTypeOf<keyof AgentRunner>().toEqualTypeOf<"model" | "sessionFrom" | "close">();
  expectTypeOf<RequiredKeys<AgentRunner>>().toEqualTypeOf<"model" | "sessionFrom" | "close">();
  expectTypeOf<AgentRunner["close"]>().toEqualTypeOf<() => Promise<void>>();
  expectTypeOf<AgentRunner["sessionFrom"]>().toEqualTypeOf<
    (result: {
      providerMetadata?: Record<string, Record<string, unknown>> | null | undefined;
    }) => AgentSessionRef | undefined
  >();

  const runner = {
    model: new MockLanguageModelV4(),
    sessionFrom: () => undefined,
    close: async () => {},
  } satisfies AgentRunner;
  expectTypeOf(runner).toExtend<AgentRunner>();
});
