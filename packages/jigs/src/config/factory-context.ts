// Which factory a process answers for, and what it is configured with, read
// through `currentFactoryContext()`. The service seeds it at boot with the
// configuration it was built with; a CLI verb or a test resolves it from disk.
// This is the one module that reads the process environment.

import { homedir } from "node:os";
import path from "node:path";
import type { RunCancellation } from "../run-cancellation.ts";
import type { FactoryConfig } from "../workflow/factory-schema.ts";
import { readFactoryConfig } from "./factory-config.ts";
import { locateFactoryRoot } from "./factory-root.ts";
import { factorySlug } from "./paths.ts";

export interface FactoryContext {
  readonly root: string;
  /** Keys this factory's rows, service record and clones apart from other factories'. */
  readonly slug: string;
  /** Read on first use, so a verb that never needs it is not stopped by a config that fails. */
  readonly config: FactoryConfig;
  /** The process environment's value. Empty is unset. */
  env(name: string): string | undefined;
}

export function resolveFactoryContext(root: string): FactoryContext {
  let config: FactoryConfig | undefined;
  return contextAt(root, () => {
    config ??= readFactoryConfig(root);
    return config;
  });
}

function contextAt(root: string, config: () => FactoryConfig): FactoryContext {
  return {
    root,
    slug: factorySlug(root),
    get config() {
      return config();
    },
    env: (name) => {
      const value = process.env[name];
      return value === "" ? undefined : value;
    },
  };
}

// On the process, not in this module: the service's steps run from the
// workflow bundle, which carries its own copy of this module.
const SEEDED = Symbol.for("jigs.factory-context");
type SeededGlobal = typeof globalThis & { [SEEDED]?: FactoryContext };

/**
 * Fix this process's factory to the configuration the service was built with, so the running
 * service never reads `jigs.config.ts`. The service calls it once, at boot.
 */
export function seedFactoryContext(config: FactoryConfig): void {
  const { root } = currentFactoryContext();
  (globalThis as SeededGlobal)[SEEDED] = contextAt(root, () => config);
}

let current: { key: string; context: FactoryContext } | undefined;

/**
 * The factory this process runs for. In the service, the one seeded at boot. Elsewhere,
 * `JIGS_FACTORY_ROOT` or the factory around the working directory, resolved once per process.
 * Throws outside a factory.
 */
export function currentFactoryContext(): FactoryContext {
  const seeded = (globalThis as SeededGlobal)[SEEDED];
  if (seeded !== undefined) return seeded;
  const override = process.env.JIGS_FACTORY_ROOT;
  const key = override !== undefined && override !== "" ? override : process.cwd();
  if (current?.key !== key) {
    current = {
      key,
      context: resolveFactoryContext(key === override ? key : locateFactoryRoot(key)),
    };
  }
  return current.context;
}

/**
 * This process's own environment, only for what a child process inherits and the variables the
 * operating system defines. A factory setting is read through {@link FactoryContext.env}.
 */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** Where jigs keeps what it owns on this machine: clones, logs, locks and harness homes. */
export function jigsDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "jigs");
}

/** A watch on the calling step's run, for a wait that should end when the run is cancelled. */
export type RunWatch = Pick<RunCancellation, "signal" | "dispose">;

// Imported on demand, because the CLI reaches this module and runs where the
// workflow SDK may not be installed. Any other import failure is a broken
// build, and swallowing it would silently stop waits from ending on cancel.
/**
 * Watch the calling step's run for `subject`, or undefined outside a step or when its status
 * cannot be read. Rejects once the run is cancelled.
 */
export async function runSignal(subject: string): Promise<RunWatch | undefined> {
  let cancellation: typeof import("../run-cancellation.ts");
  try {
    cancellation = await import("../run-cancellation.ts");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
  return cancellation.watchCallingRun(subject);
}
