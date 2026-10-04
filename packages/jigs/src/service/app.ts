// Create the HTTP application that serves a factory's workflow and webhook endpoints.

import type { World } from "@workflow/world";
import { type Context, Hono } from "hono";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { z } from "zod";
import { doctorChecks, failedChecks, runDoctorChecks } from "../checks/index.ts";
import {
  currentFactoryContext,
  type FactoryContext,
  processEnv,
} from "../config/factory-context.ts";
import { webhookSecret } from "../config/webhook-secret.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import { listResources, type RegistrySql, registrySql } from "../steps/runtime/registry.ts";
import { readRunState } from "../steps/runtime/run-state.ts";
import { JIGS_VERSION, VERSION_HEADER } from "../version.ts";
import type { Factory } from "../workflow/factory.ts";
import { parseHookToken } from "../workflow/hook-tokens.ts";
import { UNRELEASED_STATES } from "../workflow/runtime/resources.ts";
import { pushEvent } from "./event-triggers/runner.ts";
import { triggerStore } from "./event-triggers/store.ts";
import { listTriggers, triggerChecks, triggerProviders } from "./event-triggers/view.ts";
import {
  verifyGithubSignature,
  verifyLinearSignature,
  verifyPagerDutySignature,
} from "./ingress.ts";
import { startRun } from "./launch.ts";
import { pagerDutyEventType } from "./pagerduty-incidents.ts";
import { type ProviderEvent, type RouteResult, routeProviderEvent } from "./provider-events.ts";
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
  /** Where a PagerDuty delivery is handed to the event triggers. */
  triggers: { push: typeof pushEvent };
}

// The app is library code: a factory repo installs this package and hands in
// its own workflows, so nothing here may import a workflow module.
/** Build the service HTTP application for one factory's workflows and webhooks. */
export function createApp(factory: Factory, deps: Partial<AppDeps> = {}): Hono {
  const app = new Hono();
  const context = () => deps.context ?? currentFactoryContext();
  const registry = deps.registry ?? registrySql;
  const runRegistry = (): RunRegistry => ({ sql: registry(), factory: context().slug });
  const triggers = () => triggerStore(registry(), context().slug);
  const routes: IngressDeps = {
    context,
    world: deps.world ?? getWorld,
    push: deps.triggers?.push ?? pushEvent,
  };

  app.use(async (c, next) => {
    await next();
    c.header(VERSION_HEADER, JIGS_VERSION);
  });

  // Liveness, plus how far the boot has got; dependency verification is
  // preflight's job. Nitro serves this route before the plugins have run, so
  // `ready` — not the 200 — is what `jigs service start` waits on. With a
  // service per factory repo, `factoryRoot` is the only thing that says which
  // factory answers here, and `pid` which process.
  app.get("/health", (c) =>
    c.json({
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
  app.get("/api/workflows/:name/inputs", (c) => {
    const name = c.req.param("name");
    const entry = factory.workflows[name];
    if (!entry) return c.json(unknownWorkflow(name), 404);
    return c.json({
      name,
      inputs: z.toJSONSchema(entry.inputs, {
        io: "input",
        unrepresentable: "any",
      }),
    });
  });

  // The launch registry itself is the authority for what this built service
  // can run. Expose its existing input schemas for read-only CLI discovery.
  app.get("/api/workflows", (c) =>
    c.json({
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
  app.post("/api/workflows/:name/runs", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ inputs?: unknown }>().catch(() => ({}) as { inputs?: unknown });
    const result = await startRun(factory, name, body.inputs, crypto.randomUUID(), context());
    switch (result.kind) {
      case "unknown-workflow":
        return c.json(unknownWorkflow(name), 404);
      case "invalid-inputs":
        return c.json({ error: "invalid inputs", issues: result.issues }, 400);
      case "preflight-failed":
        return c.json({ error: "preflight failed", failures: failedChecks(result.report) }, 424);
      case "started":
        return c.json(
          {
            runId: result.runId,
            workflow: name,
            dashboard: dashboardPointer(context(), result.runId),
          },
          201,
        );
    }
  });

  // What this factory fires on its own, with the next occurrence of each and
  // the run it is already waiting on.
  app.get("/api/schedules", async (c) =>
    c.json(await listSchedules(factory, { listRuns: () => listRuns(factory, runRegistry()) })),
  );

  // The same catalog engine as preflight, without a workflow or a launch. A
  // red report is still a report, so it answers 200.
  app.get("/api/doctor", async (c) =>
    c.json(
      await runDoctorChecks([
        ...doctorChecks(factory.workflows, triggerProviders(factory), context()),
        ...scheduleChecks(factory),
        ...triggerChecks(factory, undefined, { store: triggers }),
      ]),
    ),
  );

  // The ingress is stateless: verify, reconstruct the token, resume. A
  // delivery nobody is listening to is acknowledged and dropped — no mapping
  // tables or persisted deliveries. Wakes are hints; consumers re-check the
  // provider. A provider whose webhooks are off has no route at all, so a
  // stray delivery is a 404 rather than work.
  if (factory.webhooks?.github?.enabled) mountGithubIngress(app, routes);
  if (factory.webhooks?.linear?.enabled) mountLinearIngress(app, routes);
  if (factory.webhooks?.pagerduty?.enabled) mountPagerDutyIngress(app, routes);

  // Manual wake on the same code path as the ingress: resume every token the
  // run's suspensions are satisfied by. The fallback when a delivery was missed.
  app.post("/api/runs/:runId/poke", async (c) => {
    const runId = c.req.param("runId");
    if (!(await runExists(runId))) return c.json({ error: "not found" }, 404);
    const run = getRun(runId);
    const tokens = await runResourceTokens(routes, run.runId);
    if (tokens.length === 0) {
      return c.json({ error: "run has no suspensions to poke" }, 409);
    }
    const poked = await Promise.all(
      tokens.map(async (token) => ({ token, ...(await wake(token, "poke")) })),
    );
    return c.json({ runId: run.runId, poked });
  });

  // Everything `jigs status` renders: each run's state, described as the
  // single-run route describes it, with the resources it recorded.
  app.get("/api/runs", async (c) => {
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
    return c.json({ runs, schedules, ...listed });
  });

  // The escape hatch for a zombie claim owner. Jigs' hooks request no minimum
  // retention, so the World removes them on run_cancelled. Capture their names
  // before the public cancellation call so the response can say what changed.
  app.post("/api/runs/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    if (!(await runExists(runId))) return c.json({ error: "not found" }, 404);
    const run = getRun(runId);
    const status = await run.status;
    if (TERMINAL_RUN_STATUSES.has(status) && status !== "cancelled") {
      return c.json({ error: `run ${runId} is already ${status}`, status }, 409);
    }
    const claimedTokens = await runResourceTokens(routes, runId);
    if (status !== "cancelled") {
      try {
        await run.cancel();
      } catch (error) {
        // Completion can win after the status read but before cancellation's
        // terminal event. Report that terminal outcome like the preflight
        // branch above instead of turning a healthy race into a 500.
        const settledStatus = await run.status;
        if (TERMINAL_RUN_STATUSES.has(settledStatus) && settledStatus !== "cancelled") {
          return c.json(
            { error: `run ${runId} is already ${settledStatus}`, status: settledStatus },
            409,
          );
        }
        throw error;
      }
    }
    const retainedTokens = await runResourceTokens(routes, runId);
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
    return c.json({
      runId,
      cancelled: true,
      releasedTokens,
      retainedTokens,
      worktrees,
    });
  });

  // What the run's own status cannot say: which steps ran, and whether a queue
  // job died holding its resume. `jigs status <run-id>` renders both.
  app.get("/api/runs/:runId/steps", async (c) => {
    const runId = c.req.param("runId");
    if (!(await runExists(runId))) return c.json({ error: "not found" }, 404);
    const [steps, deadJobs] = await Promise.all([
      listRunSteps(runId),
      listRunDeadJobs(registry(), runId),
    ]);
    return c.json({ steps, deadJobs });
  });

  // The run's state from the one reader release and prune also use. One run is
  // worth what the listing will not spend on every run: its steps, terminal or
  // not, and a round trip per halt to read the comment back from Linear.
  app.get("/api/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!(await runExists(runId))) return c.json({ error: "not found" }, 404);
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
    return c.json(body);
  });

  function unknownWorkflow(name: string) {
    return {
      error: `unknown workflow: ${name}`,
      knownWorkflows: Object.keys(factory.workflows),
    };
  }

  return app;
}

interface IngressDeps {
  context: () => FactoryContext;
  world: AppDeps["world"];
  push: typeof pushEvent;
}

function mountGithubIngress(app: Hono, deps: IngressDeps): void {
  app.post("/ingress/github", async (c) => {
    const name = c.req.header("x-github-event") ?? "unknown";
    // The boot gate refuses a service without the secret; a missing one here
    // still fails closed.
    const secret = webhookSecret("github", deps.context());
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (secret === undefined || !verifyGithubSignature(rawBody, signature, secret)) {
      console.log(`[ingress] github rejected reason=signature event=${sanitizeForLog(name)}`);
      return c.json({ error: "invalid signature" }, 401);
    }
    const payload = parseJson(rawBody);
    return answer(c, await route(deps, { provider: "github", name, payload }));
  });
}

function mountLinearIngress(app: Hono, deps: IngressDeps): void {
  app.post("/ingress/linear", async (c) => {
    const secret = webhookSecret("linear", deps.context());
    const rawBody = await c.req.text();
    const signature = c.req.header("linear-signature");
    if (secret === undefined || !verifyLinearSignature(rawBody, signature, secret)) {
      console.log("[ingress] linear rejected reason=signature");
      return c.json({ error: "invalid signature" }, 401);
    }
    const payload = parseJson(rawBody);
    const type = (payload as { type?: unknown } | null)?.type;
    const name = typeof type === "string" ? type : "";
    return answer(c, await route(deps, { provider: "linear", name, payload }));
  });
}

// An event no trigger takes, of any type, is acknowledged.
function mountPagerDutyIngress(app: Hono, deps: IngressDeps): void {
  app.post("/ingress/pagerduty", async (c) => {
    const secret = webhookSecret("pagerduty", deps.context());
    const rawBody = await c.req.text();
    const signature = c.req.header("x-pagerduty-signature");
    if (secret === undefined || !verifyPagerDutySignature(rawBody, signature, secret)) {
      console.log("[ingress] pagerduty rejected reason=signature");
      return c.json({ error: "invalid signature" }, 401);
    }
    const payload = parseJson(rawBody);
    const name = pagerDutyEventType(payload) ?? "unknown";
    const result = await route(deps, { provider: "pagerduty", name, payload });
    // Still a 2xx: PagerDuty switches a subscription off after repeated
    // failures, and the poll finds the incident anyway.
    if (result.outcome === "failed") return c.json({ delivered: false });
    return answer(c, result);
  });
}

function route(deps: IngressDeps, event: ProviderEvent): Promise<RouteResult> {
  return routeProviderEvent(event, { context: deps.context(), push: deps.push });
}

function answer(c: Context, result: RouteResult) {
  switch (result.outcome) {
    case "ignored":
      return c.json({ ignored: true });
    case "woken":
      return c.json({ delivered: true });
    case "dropped":
      return c.json({ delivered: false });
    case "failed":
      return c.json({ delivered: false }, 404);
    case "triggered":
      return c.json({ triggers: result.triggers });
  }
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

// The run's page on the dashboard this service hosts. A service started
// without a dashboard port has none to point at, and the answer is not to name
// a standalone `workflow web`: run against a live World it opens a second queue
// worker and steals the jobs this run is waiting on.
function dashboardPointer(ctx: FactoryContext, runId: string): string {
  const port = ctx.env("JIGS_DASHBOARD_PORT");
  return port === undefined || port === ""
    ? "dashboard: not configured"
    : `http://localhost:${port}/run/${runId}`;
}

// A signed but unparseable body is unroutable, like an unknown event type.
function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

// The hooks that name an external resource: what another run can be blocked
// on, and what a poke can wake. The needs-human marker is neither — the reply
// that ends that halt lands on the ticket claim beside it.
async function runResourceTokens(deps: IngressDeps, runId: string): Promise<string[]> {
  const hooks = await (await deps.world()).hooks.list({ runId });
  return hooks.data
    .map((hook) => hook.token)
    .filter((token) => parseHookToken(token)?.kind !== "needs-human");
}
