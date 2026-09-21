import type { HarnessKind, ModelKind } from "../../../blocks/agents/harness-config.ts";
import { claudeDriver } from "./claude.ts";
import { codexDriver } from "./codex.ts";
import { openaiCompatibleDriver } from "./openai-compatible.ts";
import { openrouterDriver } from "./openrouter.ts";
import { piDriver } from "./pi.ts";
import type { Driver } from "./types.ts";

type DriverKind = HarnessKind | ModelKind;
type DriverRegistry = Partial<{ [K in DriverKind]: Driver<K> }>;

/** Every installed execution driver, keyed by its descriptor kind. */
export const drivers = {
  claude: claudeDriver,
  codex: codexDriver,
  "openai-compatible": openaiCompatibleDriver,
  openrouter: openrouterDriver,
  pi: piDriver,
} as const;

const registry: DriverRegistry = drivers;

/** Return the installed driver for a descriptor kind, if this release provides one. */
export function driverFor<K extends DriverKind>(kind: K): Driver<K> | undefined {
  return registry[kind];
}

export type RegisteredDriverKind = keyof typeof drivers;
export type {
  DecisionGeneration,
  Driver,
  DriverContext,
  DriverDependencies,
  EvaluationGeneration,
  ExecutorGeneration,
} from "./types.ts";
