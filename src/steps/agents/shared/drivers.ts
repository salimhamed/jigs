import type { AskableModelSource, HarnessKind } from "../../../workflow/agents/harness-config.ts";
import { claudeDriver } from "../claude/driver.ts";
import { codexDriver } from "../codex/driver.ts";
import { openaiCompatibleDriver } from "../models/openai-compatible.ts";
import { openrouterDriver } from "../models/openrouter.ts";
import { piDriver } from "../pi/driver.ts";
import type { Driver } from "./types.ts";

// Pi's Codex subscription source runs only inside Pi, so it has no driver of its own.
export type DriverKind = HarnessKind | AskableModelSource["kind"];

/** Every installed execution driver, keyed by its descriptor kind. */
export const drivers = {
  claude: claudeDriver,
  codex: codexDriver,
  "openai-compatible": openaiCompatibleDriver,
  openrouter: openrouterDriver,
  pi: piDriver,
} as const;

const registry: { [K in DriverKind]: Driver<K> } = drivers;

/** Return the driver for a descriptor kind. */
export function driverFor<K extends DriverKind>(kind: K): Driver<K> {
  return registry[kind];
}

export type DriverResolver = typeof driverFor;

export type {
  DecisionGeneration,
  Driver,
  DriverContext,
  DriverDependencies,
  DriverDescriptor,
  EvaluationGeneration,
  ExecutorGeneration,
  HarnessTarget,
  OpenedModel,
  RunRequest,
} from "./types.ts";
