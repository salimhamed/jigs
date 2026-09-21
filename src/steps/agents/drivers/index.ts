import { claudeDriver } from "./claude.ts";
import { codexDriver } from "./codex.ts";

/** Every installed execution driver, keyed by its descriptor kind. */
export const drivers = { claude: claudeDriver, codex: codexDriver } as const;

export type RegisteredDriverKind = keyof typeof drivers;
export type { Driver, DriverContext, DriverDependencies, ExecutorGeneration } from "./types.ts";
