// Which factory a process answers for, and what it is configured with. Each
// entry point resolves one and hands it down: the service at boot, a CLI verb
// for the factory it was typed in, and step code through
// `currentFactoryContext()`.

import type { RunCancellation } from "../run-cancellation.ts";
import type { FactoryConfig } from "../workflow/factory-schema.ts";
import { readFactoryConfig } from "./factory-config.ts";
import { factoryEnvValue } from "./factory-env.ts";
import { locateFactoryRoot } from "./factory-root.ts";
import { factorySlug } from "./paths.ts";

/** A watch on the calling step's run, for a wait that should end when the run is cancelled. */
export type RunWatch = Pick<RunCancellation, "signal" | "dispose">;

export interface FactoryContext {
  readonly root: string;
  /** Keys this factory's rows, pidfile and clones apart from other factories'. */
  readonly slug: string;
  /** Read on first use, so a verb that never needs it is not stopped by a config that fails. */
  readonly config: FactoryConfig;
  /** The shell's value, else the factory's `.env`, read afresh on each call. Empty is unset. */
  env(name: string): string | undefined;
  /**
   * Watch the calling step's run for `subject`, or undefined outside a step or when its status
   * cannot be read. Rejects once the run is cancelled.
   */
  runSignal(subject: string): Promise<RunWatch | undefined>;
}

export function resolveFactoryContext(root: string): FactoryContext {
  let config: FactoryConfig | undefined;
  return {
    root,
    slug: factorySlug(root),
    get config() {
      config ??= readFactoryConfig(root);
      return config;
    },
    env: (name) => factoryEnvValue(root, name),
    runSignal,
  };
}

// The same for every factory: it watches whichever run the calling step belongs
// to. Imported on demand, because the CLI reaches this module and runs where the
// workflow SDK may not be installed.
/** {@link FactoryContext.runSignal}, for a provider client handed no context. */
export async function runSignal(subject: string): Promise<RunWatch | undefined> {
  let cancellation: typeof import("../run-cancellation.ts");
  try {
    cancellation = await import("../run-cancellation.ts");
  } catch {
    return undefined;
  }
  return cancellation.watchCallingRun(subject);
}

// Locating the factory is fallible, so it waits for the first read: a caller
// that never reads the context, or reads it inside a check, fails where it
// reads rather than where it was handed one.
function deferred(resolve: () => FactoryContext): FactoryContext {
  let resolved: FactoryContext | undefined;
  const ctx = () => {
    resolved ??= resolve();
    return resolved;
  };
  return {
    get root() {
      return ctx().root;
    },
    get slug() {
      return ctx().slug;
    },
    get config() {
      return ctx().config;
    },
    env: (name) => ctx().env(name),
    runSignal,
  };
}

let current: { key: string; context: FactoryContext } | undefined;

/**
 * The factory this process runs for: `JIGS_FACTORY_ROOT`, which the service is started with, or
 * the factory around the working directory. The one ambient lookup, resolved once per process.
 */
export function currentFactoryContext(): FactoryContext {
  const override = process.env.JIGS_FACTORY_ROOT;
  const key = override !== undefined && override !== "" ? override : process.cwd();
  if (current?.key !== key) {
    current = {
      key,
      context: deferred(() =>
        resolveFactoryContext(key === override ? key : locateFactoryRoot(key)),
      ),
    };
  }
  return current.context;
}
