// The agent's whole reach into this factory: six verbs over the same
// functions the HTTP routes call, never the routes themselves. Every result
// is small, plain JSON — a raw run listing or a step dump is a prompt nobody
// wanted to pay for, and the operator asked a question, not for a database.
//
// Nothing here throws. A tool that rejects out of the loop takes the reply
// with it, so every failure comes back as a result the model can read and say
// something about.

import { type Tool, tool } from "ai";
import { formatFailures } from "jigs/checks";
import { z } from "zod";
import type { Factory } from "../factory";
import type {
  CancelResult,
  PokeResult,
  RunDetail,
  RunTimeline,
} from "../run-actions";
import type { RunRef, RunRow } from "../runs";
import type { StartRunResult } from "../trigger";

export interface SlackToolDeps {
  factory: Factory;
  startRun: (pipeline: string, inputs: unknown) => Promise<StartRunResult>;
  logsPointer: (runId: string) => string;
  listRuns: () => Promise<RunRow[]>;
  resolveRunRef: (ref: string) => Promise<RunRef>;
  runDetail: (runId: string) => Promise<RunDetail>;
  runTimeline: (runId: string) => Promise<RunTimeline>;
  cancelRun: (runId: string) => Promise<CancelResult>;
  pokeRun: (runId: string) => Promise<PokeResult>;
}

// Enough of a timeline to answer "where is it stuck"; the dashboard is where
// a whole run's history belongs, and run_status hands over its link.
const RECENT_STEPS = 12;
const DEFAULT_RUN_LIMIT = 10;
// A failed run's error can be a whole stack; the thread needs the first line
// of it and the dashboard link, not the rest.
const ERROR_CHARS = 300;

const runRefInput = z.object({
  run: z
    .string()
    .describe(
      "a run id (full or a unique prefix) or a ticket ref like AGE-317",
    ),
});

export function slackTools(deps: SlackToolDeps): Record<string, Tool> {
  return {
    list_pipelines: tool({
      description:
        "The pipelines this factory can run, each with a JSON Schema of the inputs it takes.",
      inputSchema: z.object({}),
      execute: guard(async () => ({
        pipelines: Object.entries(deps.factory.pipelines).map(
          ([name, entry]) => ({
            name,
            // `io: "input"` is load-bearing: the default marks `.default()`ed
            // fields required, which would make the agent ask for inputs no
            // launch needs. `unrepresentable: "any"` keeps a z.date() or
            // z.custom() member from throwing the whole tool.
            inputs: z.toJSONSchema(entry.inputs, {
              io: "input",
              unrepresentable: "any",
            }),
          }),
        ),
      })),
    }),

    start_run: tool({
      description:
        "Start a run of a pipeline. Ask the operator for any input you were not given rather than inventing one.",
      inputSchema: z.object({
        pipeline: z.string(),
        inputs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("the pipeline's inputs, shaped by its JSON Schema"),
      }),
      execute: guard(async ({ pipeline, inputs }) =>
        started(deps, pipeline, await deps.startRun(pipeline, inputs ?? {})),
      ),
    }),

    list_runs: tool({
      description:
        "This factory's runs, newest first. Statuses are running, suspended, stalled, completed, failed and cancelled.",
      inputSchema: z.object({
        status: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: guard(async ({ status, limit }) => {
        const runs = await deps.listRuns();
        const matching =
          status === undefined
            ? runs
            : runs.filter((run) => run.status === status);
        return {
          total: matching.length,
          runs: matching.slice(0, limit ?? DEFAULT_RUN_LIMIT),
        };
      }),
    }),

    run_status: tool({
      description:
        "One run in detail: its status, why it is parked if it is, and its most recent steps.",
      inputSchema: runRefInput,
      execute: guard(async ({ run }) =>
        withRun(deps, run, async (runId) => {
          const [detail, timeline] = await Promise.all([
            deps.runDetail(runId),
            deps.runTimeline(runId),
          ]);
          // Field by field, never a spread of the detail: `returnValue` is a
          // pipeline's whole output — a brief, a diff, a ticket snapshot —
          // and putting it in the prompt is paying to summarise something
          // nobody asked about.
          return {
            runId: detail.runId,
            status: detail.status,
            logs: detail.logs,
            suspended: detail.suspended,
            error: truncate(detail.error),
            suspensions: detail.suspensions?.map((s) => ({
              reason: s.reason,
              satisfiedBy: s.satisfiedBy,
            })),
            steps: timeline.steps.slice(-RECENT_STEPS),
            deadJobs: timeline.deadJobs.map((job) => ({
              task: job.task,
              attempts: job.attempts,
              lastError: truncate(job.lastError),
            })),
          };
        }),
      ),
    }),

    cancel_run: tool({
      description:
        "Cancel a run. Only when the operator has explicitly asked for it; it cannot be undone, and the run's worktree stays on disk for `jigs sweep`.",
      inputSchema: runRefInput,
      execute: guard(async ({ run }) =>
        withRun(deps, run, async (runId) => {
          const result = await deps.cancelRun(runId);
          return result.kind === "already-terminal"
            ? { error: `run ${runId} is already ${result.status}` }
            : {
                runId: result.runId,
                cancelled: true,
                worktrees: result.worktrees,
              };
        }),
      ),
    }),

    poke_run: tool({
      description:
        "Re-check what a suspended run is waiting on, in case a webhook delivery was missed. Harmless: an unsatisfied run simply re-suspends.",
      inputSchema: runRefInput,
      execute: guard(async ({ run }) =>
        withRun(deps, run, async (runId) => {
          const result = await deps.pokeRun(runId);
          return result.kind === "no-suspensions"
            ? { error: `run ${runId} has no suspensions to poke` }
            : { runId: result.runId, poked: result.poked };
        }),
      ),
    }),
  };
}

function started(
  deps: SlackToolDeps,
  pipeline: string,
  result: StartRunResult,
): unknown {
  switch (result.kind) {
    case "started":
      return {
        runId: result.runId,
        pipeline,
        status: "started",
        logs: deps.logsPointer(result.runId),
      };
    case "unknown-pipeline":
      return {
        error: `unknown pipeline: ${pipeline}`,
        knownPipelines: result.knownPipelines,
      };
    case "invalid-inputs":
      return {
        error: "invalid inputs",
        issues: result.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      };
    case "invalid-ticket":
      return { error: `invalid ticket: ${result.reason}` };
    case "preflight-failed":
      // The aggregated repair text, verbatim: it is what `jigs doctor` prints
      // and what the operator has to act on, so paraphrasing it in a Slack
      // reply is how a factory stays broken.
      return {
        error: "preflight failed",
        failures: formatFailures(result.report),
      };
  }
}

async function withRun(
  deps: SlackToolDeps,
  ref: string,
  run: (runId: string) => Promise<unknown>,
): Promise<unknown> {
  const resolved = await deps.resolveRunRef(ref);
  if (resolved.kind === "ambiguous") {
    return {
      error: `${ref} matches more than one run`,
      candidates: resolved.candidates,
    };
  }
  if (resolved.kind === "unknown") return { error: `no run matching ${ref}` };
  return run(resolved.runId);
}

function truncate(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) return undefined;
  return text.length <= ERROR_CHARS ? text : `${text.slice(0, ERROR_CHARS)}…`;
}

function guard<A>(
  run: (args: A) => Promise<unknown>,
): (args: A) => Promise<unknown> {
  return async (args) => {
    try {
      return await run(args);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}
