// Create the HTTP application that serves a factory's workflow endpoints.

import type { RequestListener } from "node:http";
import { json as readJson } from "node:stream/consumers";
import type { World } from "@workflow/world";
import express, { type ErrorRequestHandler } from "express";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { z } from "zod";
import { doctorChecks, failedChecks, runDoctorChecks } from "../checks/index.ts";
import {
  currentFactoryContext,
  type FactoryContext,
  processEnv,
} from "../config/factory-context.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import { listResources, type RegistrySql, registrySql } from "../steps/runtime/registry.ts";
import { readRunState } from "../steps/runtime/run-state.ts";
import { JIGS_VERSION, VERSION_HEADER } from "../version.ts";
import type { Factory } from "../workflow/factory.ts";
import { isOwnershipKind, parseHookToken } from "../workflow/hook-tokens.ts";
import { UNRELEASED_STATES } from "../workflow/runtime/resources.ts";
import { activeFactory } from "./active.ts";
import { triggerStore } from "./event-triggers/store.ts";
import { listTriggers, triggerChecks, triggerInstallations } from "./event-triggers/view.ts";
import { startRun } from "./launch.ts";
import { listRunDeadJobs } from "./queue.ts";
import { bootPhase, isReady } from "./readiness.ts";
import {
  enrichSuspensions,
  listRunSteps,
  listRuns,
  type RunRegistry,
  runExists,
  worldRunFacts,
} from "./runs.ts";
import { listSchedules, scheduleChecks } from "./schedules.ts";
import { wake } from "./wake.ts";

/** What the routes reach beyond the request. Each defaults to the service's own. */
export interface AppDeps {
  /** The factory the service answers for. */
  context: FactoryContext;
  /** The World whose hooks a poke and a cancel list. */
  world: () => Promise<{ hooks: Pick<World["hooks"], "list"> }>;
  /** The jigs registry. */
  registry: () => RegistrySql;
}

// The app is library code: a factory repo installs this package and hands in
// its own workflows, so nothing here may import a workflow module.
/** Build the service HTTP application for one factory's workflows. */
export function createApp(factory: Factory, deps: Partial<AppDeps> = {}): RequestListener {
  const app = express();
  app.disable("x-powered-by");
  const context = () => deps.context ?? currentFactoryContext();
  const registry = deps.registry ?? registrySql;
  const runRegistry = (): RunRegistry => ({ sql: registry(), factory: context().slug });
  const triggers = () => triggerStore(registry(), context().slug);
  const world = deps.world ?? getWorld;

  app.use((_request, response, next) => {
    response.set(VERSION_HEADER, JIGS_VERSION);
    next();
  });

  // Liveness, plus how far the boot has got; dependency verification is
  // preflight's job. Nitro serves this route before the plugins have run, so
  // `ready` — not the 200 — is what `jigs up` waits on. With a
  // service per factory repo, `factoryRoot` is the only thing that says which
  // factory answers here, and `pid` which process.
  app.get("/health", (_request, response) =>
    response.json({
      ok: true,
      ready: isReady(),
      phase: bootPhase(),
      world: processEnv().WORKFLOW_TARGET_WORLD ?? "local (default)",
      factoryRoot: factoryRootOrNull(context),
      pid: process.pid,
      workflows: Object.keys(factory.workflows),
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  // The `inputs` contract the CLI validates `--input` against before it ever
  // calls the trigger. `io: "input"` is load-bearing: the default marks
  // `.default()`ed fields required, which would reject every valid launch.
  // `unrepresentable: "any"` keeps a schema holding a z.date()/z.bigint()/
  // z.custom() from throwing the whole route to a 500 — the member renders as
  // `{}` and entry.inputs.safeParse at the trigger stays its real authority.
  app.get("/api/workflows/:name/inputs", (request, response) => {
    const name = request.params.name;
    const entry = factory.workflows[name];
    if (!entry) {
      response.status(404).json(unknownWorkflow(name));
      return;
    }
    response.json({
      name,
      inputs: z.toJSONSchema(entry.inputs, {
        io: "input",
        unrepresentable: "any",
      }),
    });
  });

  // The launch registry itself is the authority for what this built service
  // can run. Expose its existing input schemas for read-only CLI discovery.
  app.get("/api/workflows", (_request, response) =>
    response.json({
      workflows: Object.entries(factory.workflows).map(([name, entry]) => ({
        name,
        inputs: z.toJSONSchema(entry.inputs, {
          io: "input",
          unrepresentable: "any",
        }),
      })),
    }),
  );

  // The manual half of the trigger path; the schedule ticker fires the same
  // function, so preflight cannot differ between them.
  app.post("/api/workflows/:name/runs", async (request, response) => {
    const name = request.params.name;
    // Not express.json(): any content type is read, and a malformed body is no inputs.
    const body = (await readJson(request).catch(() => ({}))) as { inputs?: unknown };
    const result = await startRun(factory, name, body.inputs, crypto.randomUUID(), context());
    switch (result.kind) {
      case "unknown-workflow":
        response.status(404).json(unknownWorkflow(name));
        return;
      case "invalid-inputs":
        response.status(400).json({ error: "invalid inputs", issues: result.issues });
        return;
      case "preflight-failed":
        response
          .status(424)
          .json({ error: "preflight failed", failures: failedChecks(result.report) });
        return;
      case "started":
        response.status(201).json({
          runId: result.runId,
          workflow: name,
          dashboard: dashboardPointer(context(), result.runId),
        });
        return;
    }
  });

  // What this factory fires on its own, with the next occurrence of each and
  // the run it is already waiting on.
  app.get("/api/schedules", async (_request, response) =>
    response.json(
      await listSchedules(factory, { listRuns: () => listRuns(factory, runRegistry()) }),
    ),
  );

  // The same catalog engine as preflight, without a workflow or a launch. A
  // red report is still a report, so it answers 200.
  app.get("/api/doctor", async (_request, response) => {
    const live = activeFactory(factory);
    response.json(
      await runDoctorChecks([
        ...doctorChecks(live.workflows, triggerInstallations(live), context()),
        ...scheduleChecks(live),
        ...triggerChecks(live, undefined, { store: triggers }),
      ]),
    );
  });

  // Manual wake on the same code path as a provider event: resume every token
  // the run's suspensions are satisfied by. The fallback when an event was missed.
  app.post("/api/runs/:runId/poke", async (request, response) => {
    const runId = request.params.runId;
    if (!(await runExists(runId))) {
      response.status(404).json({ error: "not found" });
      return;
    }
    const run = getRun(runId);
    // A token jigs did not mint is poked too: a factory's own workflow may park on it.
    const tokens = (await heldTokens(world, run.runId)).filter(
      (token) => !isOwnershipKind(parseHookToken(token)?.kind),
    );
    if (tokens.length === 0) {
      response.status(409).json({ error: "run has no suspensions to poke" });
      return;
    }
    const poked = await Promise.all(
      tokens.map(async (token) => ({ token, ...(await wake(token, "poke")) })),
    );
    response.json({ runId: run.runId, poked });
  });

  // Everything `jigs status` renders: each run's state, described as the
  // single-run route describes it, with the resources it recorded.
  app.get("/api/runs", async (_request, response) => {
    const runs = await listRuns(factory, runRegistry());
    // The schedules ride along on the same run listing the table above
    // renders, so status stays one round trip and the two tables can never
    // disagree about which schedule is busy.
    const schedules = await listSchedules(factory, {
      listRuns: async () => runs,
    });
    // A registry error costs the triggers section, never the runs above it.
    const listed = await Promise.resolve()
      .then(() => listTriggers(factory, { store: triggers() }))
      .then(
        (views) => ({ triggers: views }),
        (error: unknown) => ({ triggers: [], triggersError: String(error) }),
      );
    response.json({ runs, schedules, ...listed });
  });

  // The escape hatch for a zombie claim owner. Jigs' hooks request no minimum
  // retention, so the World removes them on run_cancelled. Capture their names
  // before the public cancellation call so the response can say what changed.
  app.post("/api/runs/:runId/cancel", async (request, response) => {
    const runId = request.params.runId;
    if (!(await runExists(runId))) {
      response.status(404).json({ error: "not found" });
      return;
    }
    const run = getRun(runId);
    const status = await run.status;
    if (TERMINAL_RUN_STATUSES.has(status) && status !== "cancelled") {
      response.status(409).json({ error: `run ${runId} is already ${status}`, status });
      return;
    }
    const claimedTokens = await heldTokens(world, runId);
    if (status !== "cancelled") {
      try {
        await run.cancel();
      } catch (error) {
        // Completion can win after the status read but before cancellation's
        // terminal event. Report that terminal outcome like the preflight
        // branch above instead of turning a healthy race into a 500.
        const settledStatus = await run.status;
        if (TERMINAL_RUN_STATUSES.has(settledStatus) && settledStatus !== "cancelled") {
          response
            .status(409)
            .json({ error: `run ${runId} is already ${settledStatus}`, status: settledStatus });
          return;
        }
        throw error;
      }
    }
    const retainedTokens = await heldTokens(world, runId);
    const retained = new Set(retainedTokens);
    const releasedTokens = claimedTokens.filter((token) => !retained.has(token));
    // Cancel leaves the worktree behind: name what stays so the operator knows
    // where it is and that offline resource prune is the way to reclaim it.
    const worktrees = (
      await listResources(registry(), {
        factory: context().slug,
        runId,
        kind: "worktree",
        states: UNRELEASED_STATES,
      })
    ).map((row) => row.identity);
    // A merged run's workflow tears its own worktree down; everything else —
    // cancel included — leaves the tree on disk for the operator's offline
    // resource prune. A cancelled run's dirty tree is diagnosis evidence that
    // prune surfaces but will not delete.
    response.json({
      runId,
      cancelled: true,
      releasedTokens,
      retainedTokens,
      worktrees,
    });
  });

  // What the run's own status cannot say: which steps ran, and whether a queue
  // job died holding its resume. `jigs status <run-id>` renders both.
  app.get("/api/runs/:runId/steps", async (request, response) => {
    const runId = request.params.runId;
    if (!(await runExists(runId))) {
      response.status(404).json({ error: "not found" });
      return;
    }
    const [steps, deadJobs] = await Promise.all([
      listRunSteps(runId),
      listRunDeadJobs(registry(), runId),
    ]);
    response.json({ steps, deadJobs });
  });

  // The run's state from the one reader release and prune also use. One run is
  // worth what the listing will not spend on every run: its steps, terminal or
  // not, and a round trip per halt to read the comment back from Linear.
  app.get("/api/runs/:runId", async (request, response) => {
    const runId = request.params.runId;
    if (!(await runExists(runId))) {
      response.status(404).json({ error: "not found" });
      return;
    }
    const state = await readRunState(registry(), context().slug, runId, (id) =>
      worldRunFacts(id, factory, runRegistry()),
    );
    const body: Record<string, unknown> = {
      ...state,
      suspensions: await enrichSuspensions(state.suspensions, runId),
      dashboard: dashboardPointer(context(), runId),
    };
    // Read only where there is one: a running run's return value is a promise
    // that settles long after this response.
    if (state.status === "completed") {
      body.returnValue = await getRun(runId).returnValue;
    }
    if (state.status === "failed") {
      body.error = await getRun(runId).returnValue.then(
        () => undefined,
        (err: unknown) => String(err),
      );
    }
    response.json(body);
  });

  // Plain text rather than Express's HTML pages: the CLI prints a failed
  // answer's body as it is.
  app.use((_request, response) => {
    response.status(404).type("text").send("404 Not Found");
  });
  app.use(((error, _request, response, _next) => {
    console.error(error);
    response.status(500).type("text").send("Internal Server Error");
  }) satisfies ErrorRequestHandler);

  function unknownWorkflow(name: string) {
    return {
      error: `unknown workflow: ${name}`,
      knownWorkflows: Object.keys(factory.workflows),
    };
  }

  return app;
}

// Liveness must answer from anywhere, including a service started outside a
// factory, so an unlocatable root is reported rather than thrown as a 500.
function factoryRootOrNull(context: () => FactoryContext): string | null {
  try {
    return context().root;
  } catch {
    return null;
  }
}

// The run's page on the dashboard this service hosts, never a standalone
// `workflow web`: run against a live World it opens a second queue worker and
// steals the jobs this run is waiting on.
function dashboardPointer(ctx: FactoryContext, runId: string): string {
  return `http://localhost:${ctx.env("JIGS_DASHBOARD_PORT")}/run/${runId}`;
}

// Every hook the run holds, the locks among them.
async function heldTokens(world: AppDeps["world"], runId: string): Promise<string[]> {
  const hooks = await (await world()).hooks.list({ runId });
  return hooks.data.map((hook) => hook.token);
}
