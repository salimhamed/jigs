// What "the saved session is unusable" means, in one place. A step never
// rejects on it (the workflow runtime retries a rejected step), so the step
// returns a marker, this module is where the marker becomes a throw, and an
// agent session is the only thing that catches it. A reference recorded on the
// other harness arrives as the same marker as a stale one.

import type { z } from "zod";
import type { Harness } from "./harness-config.ts";
import type { RunAgentOptions } from "./plan.ts";
import type { AgentResult, AgentSessionRef } from "./result.ts";

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

/** Run an agent through the factory's bound step wrapper. */
export type RunAgentFn = <T = undefined>(config: RunAgentOptions<T>) => Promise<AgentResult<T>>;

/** The two ways to state one turn of an agent session. */
export interface AgentSessionTurn {
  /**
   * Sent to an agent that already holds the earlier turns: only what is new. A function is called
   * only when the resume is taken.
   */
  resume: string | (() => Promise<string>);
  /**
   * Sent to an agent starting from nothing: everything it needs. A function is called only when
   * the session starts fresh, so gathering its context costs nothing on a resume.
   */
  fresh: string | (() => Promise<string>);
}

/**
 * One agent across several turns of a workflow.
 *
 * @remarks
 * `run` resumes the harness session the agent session holds. When that session is gone, or it was
 * recorded on a different harness descriptor, `run` starts fresh with the `fresh` prompt instead.
 */
export interface AgentSession {
  readonly harness: Harness;
  /** With `output`, the answer is validated against it and returned parsed. */
  run<T>(turn: AgentSessionTurn & { output: z.ZodType<T> }): Promise<T>;
  run(turn: AgentSessionTurn): Promise<void>;
}

/** What an agent session is started with. */
export interface AgentSessionOptions {
  /** Names the session in log lines. */
  name: string;
  harness: Harness;
  cwd: string;
}

// Field order is not identity: a descriptor, or a Pi descriptor's nested model
// source, built with its fields in another order is the same harness.
function canonical(harness: Harness): string {
  return JSON.stringify(harness, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : field,
  );
}

async function render(prompt: string | (() => Promise<string>)): Promise<string> {
  return typeof prompt === "string" ? prompt : prompt();
}

/**
 * Build `agentSession` around the factory's bound `runAgent`.
 *
 * @group Factory plumbing
 */
export function bindAgentSession(runAgent: RunAgentFn) {
  /**
   * Start an agent session. Nothing runs until the first `run`.
   *
   * @remarks
   * The session reference is held as plain data and comes from recorded step results, so the
   * object is rebuilt the same way on every replay.
   */
  return function agentSession(options: AgentSessionOptions): AgentSession {
    const { name, harness, cwd } = options;
    // A reference is resumed only on the descriptor it was recorded with, and
    // only on the harness kind it names: a replay after a redeploy can hand
    // back a reference another harness recorded.
    let held: { descriptor: string; ref: AgentSessionRef } | undefined;
    const record = (ref: AgentSessionRef | undefined) => {
      held = ref === undefined ? undefined : { descriptor: canonical(harness), ref };
    };

    function resumable(): AgentSessionRef | undefined {
      if (held === undefined) return undefined;
      if (held.ref.harness === harness.kind && held.descriptor === canonical(harness)) {
        return held.ref;
      }
      console.log(
        `[agentSession:${name}] session ${held.ref.id} was recorded on another harness; starting fresh`,
      );
      return undefined;
    }

    async function run<T>(turn: AgentSessionTurn & { output: z.ZodType<T> }): Promise<T>;
    async function run(turn: AgentSessionTurn): Promise<void>;
    async function run(turn: AgentSessionTurn & { output?: z.ZodType<unknown> }): Promise<unknown> {
      const resume = resumable();
      if (resume !== undefined) {
        try {
          const resumed = await runAgent({
            harness,
            cwd,
            resume,
            prompt: await render(turn.resume),
            output: turn.output,
          });
          record(resumed.session ?? resume);
          return resumed.output;
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err;
          console.log(`[agentSession:${name}] resume failed; starting fresh: ${err.message}`);
        }
      }
      const started = await runAgent({
        harness,
        cwd,
        prompt: await render(turn.fresh),
        output: turn.output,
      });
      record(started.session);
      return started.output;
    }

    return { harness, run };
  };
}
