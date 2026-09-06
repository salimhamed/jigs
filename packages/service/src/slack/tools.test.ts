import type { Tool } from "ai";
import { expect, test } from "vitest";
import { z } from "zod";
import type { Factory } from "../factory";
import { type SlackToolDeps, slackTools } from "./tools";

const FACTORY: Factory = {
  pipelines: {
    ticket: {
      pipeline: async () => ({}),
      inputs: z.object({
        ticket: z.string(),
        draft: z.boolean().default(false),
      }),
    },
  },
};

const RUN = "wrun_01JQPZ0000000000000000001";

function tools(over: Partial<SlackToolDeps> = {}) {
  const calls: string[] = [];
  const deps: SlackToolDeps = {
    factory: FACTORY,
    startRun: async () => ({ kind: "started", runId: RUN }),
    logsPointer: (runId) => `http://localhost:9099/run/${runId}`,
    listRuns: async () => [
      {
        runId: RUN,
        pipeline: "ticket",
        status: "suspended",
        trigger: "manual",
        createdAt: "2026-09-06T00:00:00.000Z",
      },
      {
        runId: "wrun_01JQPZ0000000000000000002",
        pipeline: "ticket",
        status: "completed",
        trigger: "schedule:nightly",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    resolveRunRef: async () => ({ kind: "found", runId: RUN }),
    runDetail: async (runId) => ({
      runId,
      status: "suspended",
      logs: "http://localhost:9099/run/x",
      suspended: true,
      returnValue: { brief: "x".repeat(5_000) },
      error: "y".repeat(1_000),
      suspensions: [
        { key: "pr", reason: "awaiting PR approval", satisfiedBy: "gh:1" },
      ],
    }),
    runTimeline: async () => ({
      steps: Array.from({ length: 20 }, (_, i) => ({
        name: `step-${i}`,
        status: "completed",
        attempt: 1,
        startedAt: null,
        completedAt: null,
        error: null,
      })),
      deadJobs: [],
    }),
    cancelRun: async (runId) => {
      calls.push(`cancel:${runId}`);
      return {
        kind: "cancelled",
        runId,
        releasedTokens: ["gh:1"],
        worktrees: ["/w/1"],
      };
    },
    pokeRun: async (runId) => {
      calls.push(`poke:${runId}`);
      return {
        kind: "poked",
        runId,
        poked: [{ token: "gh:1", resumed: true }],
      };
    },
    ...over,
  };
  return { calls, tools: slackTools(deps) };
}

const run = async (tool: Tool | undefined, args: unknown): Promise<unknown> => {
  const execute = tool?.execute;
  if (execute === undefined) throw new Error("tool has no execute");
  // The runtime context the SDK passes is untouched by every tool here.
  return execute(args as never, {} as never);
};

test("list_pipelines answers with each pipeline's input schema, not its zod object", async () => {
  const { tools: t } = tools();
  const result = (await run(t.list_pipelines, {})) as {
    pipelines: Array<{ name: string; inputs: { required?: string[] } }>;
  };
  expect(result.pipelines.map((p) => p.name)).toEqual(["ticket"]);
  // `io: "input"`: a defaulted field is not something to ask the operator for.
  expect(result.pipelines[0]?.inputs.required).toEqual(["ticket"]);
});

test("start_run hands back the run it created", async () => {
  const { tools: t } = tools();
  expect(
    await run(t.start_run, { pipeline: "ticket", inputs: { ticket: "AGE-1" } }),
  ).toEqual({
    runId: RUN,
    pipeline: "ticket",
    status: "started",
    // The same pointer the trigger route hands the CLI: without it the reply
    // names a run id nobody can open.
    logs: `http://localhost:9099/run/${RUN}`,
  });
});

test("start_run reports bad inputs as fields, so the agent can ask for the right one", async () => {
  const { tools: t } = tools({
    startRun: async () => ({
      kind: "invalid-inputs",
      issues: [
        { code: "invalid_type", path: ["ticket"], message: "Invalid input" },
      ] as never,
    }),
  });
  expect(await run(t.start_run, { pipeline: "ticket" })).toEqual({
    error: "invalid inputs",
    issues: ["ticket: Invalid input"],
  });
});

test("start_run passes preflight's own repair text through unparaphrased", async () => {
  const { tools: t } = tools({
    startRun: async () => ({
      kind: "preflight-failed",
      report: {
        ok: false,
        checks: [
          {
            id: "linear.key",
            label: "Linear API key",
            ok: false,
            reason: "LINEAR_API_KEY is unset",
            repair: "set LINEAR_API_KEY in .env",
          },
        ],
      },
    }),
  });
  const result = (await run(t.start_run, { pipeline: "ticket" })) as {
    failures: string;
  };
  expect(result.failures).toContain("set LINEAR_API_KEY in .env");
});

test("start_run naming a pipeline this factory has not got says what it does have", async () => {
  const { tools: t } = tools({
    startRun: async () => ({
      kind: "unknown-pipeline",
      knownPipelines: ["ticket"],
    }),
  });
  expect(await run(t.start_run, { pipeline: "nope" })).toEqual({
    error: "unknown pipeline: nope",
    knownPipelines: ["ticket"],
  });
});

test("list_runs filters by status and caps what comes back", async () => {
  const { tools: t } = tools();
  expect(await run(t.list_runs, { status: "suspended" })).toEqual({
    total: 1,
    runs: [
      {
        runId: RUN,
        pipeline: "ticket",
        status: "suspended",
        trigger: "manual",
        createdAt: "2026-09-06T00:00:00.000Z",
      },
    ],
  });
  const capped = (await run(t.list_runs, { limit: 1 })) as { runs: unknown[] };
  expect(capped.runs).toHaveLength(1);
});

test("run_status trims the timeline rather than dumping every step into the prompt", async () => {
  const { tools: t } = tools();
  const result = (await run(t.run_status, { run: "wrun_01J" })) as {
    steps: unknown[];
    suspensions: unknown[];
    logs: string;
    error: string;
  };
  expect(result.steps).toHaveLength(12);
  expect(result.suspensions).toEqual([
    { reason: "awaiting PR approval", satisfiedBy: "gh:1" },
  ]);
  expect(result.logs).toBe("http://localhost:9099/run/x");
  // A pipeline's return value is a whole brief or diff; paying to summarise
  // something nobody asked about is not what the question was.
  expect(result).not.toHaveProperty("returnValue");
  expect(result.error).toHaveLength(301);
  expect(result.error.endsWith("…")).toBe(true);
});

test("a ref nothing matches is an answer, not a thrown loop", async () => {
  const { tools: t, calls } = tools({
    resolveRunRef: async () => ({ kind: "unknown" }),
  });
  expect(await run(t.cancel_run, { run: "AGE-999" })).toEqual({
    error: "no run matching AGE-999",
  });
  expect(calls).toEqual([]);
});

test("an ambiguous ref names the candidates rather than picking one", async () => {
  const { tools: t } = tools({
    resolveRunRef: async () => ({ kind: "ambiguous", candidates: ["a", "b"] }),
  });
  expect(await run(t.run_status, { run: "wrun_01" })).toEqual({
    error: "wrun_01 matches more than one run",
    candidates: ["a", "b"],
  });
});

test("cancel_run and poke_run act on the resolved run and report what changed", async () => {
  const { tools: t, calls } = tools();
  expect(await run(t.cancel_run, { run: "AGE-1" })).toEqual({
    runId: RUN,
    cancelled: true,
    worktrees: ["/w/1"],
  });
  expect(await run(t.poke_run, { run: "AGE-1" })).toEqual({
    runId: RUN,
    poked: [{ token: "gh:1", resumed: true }],
  });
  expect(calls).toEqual([`cancel:${RUN}`, `poke:${RUN}`]);
});

test("a run already finished cannot be cancelled twice", async () => {
  const { tools: t } = tools({
    cancelRun: async () => ({ kind: "already-terminal", status: "completed" }),
  });
  expect(await run(t.cancel_run, { run: RUN })).toEqual({
    error: `run ${RUN} is already completed`,
  });
});

test("a service function that throws comes back as a tool result", async () => {
  // A rejection out of the loop takes the whole reply with it, and the
  // operator sees silence instead of what went wrong.
  const { tools: t } = tools({
    listRuns: () => Promise.reject(new Error("the World is unreachable")),
  });
  expect(await run(t.list_runs, {})).toEqual({
    error: "the World is unreachable",
  });
});
