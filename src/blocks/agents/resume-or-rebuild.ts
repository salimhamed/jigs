// What "the saved session is unusable" means, in one place. A step never
// rejects on it — workflow@4.8.4 would retry a rejection three times — so the
// step returns a marker, this module is where the marker becomes a throw, and
// `resumeOrRebuild` is the only thing that catches it. A pointer recorded on
// the other harness arrives as the same marker as a stale one, so no caller
// owns a mismatch check of its own.

import type { z } from "zod";
import type { HarnessConfig } from "./harness-config.ts";
import type { RunAgentOptions } from "./plan.ts";
import type { AgentResult, AgentSession } from "./result.ts";

// Private on purpose: `instanceof` only means something on this side of the
// step boundary, and only to the fallback below.
class ResumeFailedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ResumeFailedError";
  }
}

/** Turns the step's returned marker into the throw the fallback catches. */
export function resumeFailed(detail: string): never {
  throw new ResumeFailedError(detail);
}

/** Run an agent through the factory’s bound step wrapper. */
export type RunAgentFn = <T = undefined>(config: RunAgentOptions<T>) => Promise<AgentResult<T>>;

export interface ResumeOrRebuildOptions<T> {
  runAgent: RunAgentFn;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  /**
   * For an agent that already holds the change: no context is re-sent.
   * Deferred so that rendering it costs nothing when the rebuild is taken.
   */
  resumePrompt: string | (() => Promise<string>);
  /**
   * The same job stated to an agent that holds nothing. Deferred so that
   * gathering what it needs — a diff read is a step call — costs nothing when
   * the resume is taken.
   */
  freshPrompt: string | (() => Promise<string>);
  output?: z.ZodType<T>;
  /** Prefixes the one log line the fallback writes. */
  label: string;
}

export interface ResumeOrRebuildResult<T> {
  output: T;
  /** The session holding the completed work, whether resumed or newly created. */
  session?: AgentSession;
}

async function render(prompt: string | (() => Promise<string>)): Promise<string> {
  return typeof prompt === "string" ? prompt : prompt();
}

/**
 * Resume the agent that did the work; failing that, run the same job in a
 * fresh context. The rebuild is a first-class path, never a degraded one:
 * both arms answer the same shape.
 */
export async function resumeOrRebuild<T = undefined>(
  options: ResumeOrRebuildOptions<T>,
): Promise<ResumeOrRebuildResult<T>> {
  const base = {
    harness: options.harness,
    cwd: options.cwd,
    ...(options.output === undefined ? {} : { output: options.output }),
  };

  if (options.session !== undefined) {
    try {
      const resumed = await options.runAgent<T>({
        ...base,
        resume: options.session,
        prompt: await render(options.resumePrompt),
      });
      return { output: resumed.output, session: resumed.session ?? options.session };
    } catch (err) {
      if (!(err instanceof ResumeFailedError)) throw err;
      console.log(
        `[${options.label}] resume failed — falling back to a fresh context: ${err.message}`,
      );
    }
  }

  const rebuilt = await options.runAgent<T>({ ...base, prompt: await render(options.freshPrompt) });
  return {
    output: rebuilt.output,
    ...(rebuilt.session === undefined ? {} : { session: rebuilt.session }),
  };
}
