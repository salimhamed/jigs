import { type Context, Hono } from "hono";
import { getRun, resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { getWorld } from "workflow/runtime";
import { z } from "zod";
import { doctorChecks, failedChecks, runChecks } from "./checks/index.ts";
import { factoryRoot } from "./config/factory-root.ts";
import type { Factory } from "./factory.ts";
import {
  githubWebhookSecret,
  linearTimestampFresh,
  verifyGithubSignature,
  verifyLinearSignature,
} from "./ingress.ts";
import { bootPhase, isReady } from "./readiness.ts";
import {
  derivedRunStatus,
  listRuns,
  parkReason,
  type RunRef,
  resolveRunRef,
  stalledRuns,
  TERMINAL_RUN_STATUSES,
} from "./runs.ts";
import { listSchedules, scheduleChecks } from "./schedules.ts";
import { listRunDeadJobs, listRunSteps } from "./stalls.ts";
import {
  NEEDS_HUMAN_TOKEN_PREFIX,
  tokenFromGithubPayload,
  tokenFromLinearPayload,
} from "./suspension/tokens.ts";
import { startRun } from "./trigger.ts";
import { listWorktreesForRun } from "./worktrees/registry.ts";
import { registrySql } from "./worktrees/sql.ts";
import { sweepWorktrees } from "./worktrees/sweep.ts";

// The app is library code: a factory repo installs this package and hands in
// its own pipelines, so nothing here may import a pipeline module.
export function createApp(
  factory: Factory,
  deps: { resumeIngressHook?: typeof resumeHook } = {},
): Hono {
  const app = new Hono();
  const resumeIngressHook = deps.resumeIngressHook ?? resumeHook;

  // Liveness, plus how far the boot has got; dependency verification is
  // preflight's job (ADR 0010). Nitro serves this route before the plugins
  // have run, so `ready` — not the 200 — is what `jigs service start` waits
  // on. With a service per factory repo, `factoryRoot` is the only thing that
  // says which factory answers here.
  app.get("/health", (c) =>
    c.json({
      ok: true,
      ready: isReady(),
      phase: bootPhase(),
      world: process.env.WORKFLOW_TARGET_WORLD ?? "local (default)",
      factoryRoot: factoryRootOrNull(),
      pipelines: Object.keys(factory.pipelines),
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  // The `inputs` contract the CLI validates `--input` against before it ever
  // calls the trigger. `io: "input"` is load-bearing: the default marks
  // `.default()`ed fields required, which would reject every valid launch.
  // `unrepresentable: "any"` keeps a schema holding a z.date()/z.bigint()/
  // z.custom() from throwing the whole route to a 500 — the member renders as
  // `{}` and entry.inputs.safeParse at the trigger stays its real authority.
  app.get("/api/pipelines/:name/inputs", (c) => {
    const name = c.req.param("name");
    const entry = factory.pipelines[name];
    if (!entry) return c.json(unknownPipeline(name), 404);
    return c.json({
      name,
      inputs: z.toJSONSchema(entry.inputs, {
        io: "input",
        unrepresentable: "any",
      }),
    });
  });

  // The manual half of the trigger path; the schedule ticker fires the same
  // function, so preflight and ticket resolution cannot differ between them.
  app.post("/api/pipelines/:name/runs", async (c) => {
    const name = c.req.param("name");
    const body = await c.req
      .json<{ inputs?: unknown }>()
      .catch(() => ({}) as { inputs?: unknown });
    const result = await startRun(
      factory,
      name,
      body.inputs,
      crypto.randomUUID(),
    );
    switch (result.kind) {
      case "unknown-pipeline":
        return c.json(unknownPipeline(name), 404);
      case "invalid-inputs":
        return c.json({ error: "invalid inputs", issues: result.issues }, 400);
      case "preflight-failed":
        return c.json(
          { error: "preflight failed", failures: failedChecks(result.report) },
          424,
        );
      case "invalid-ticket":
        return c.json({ error: `invalid ticket: ${result.reason}` }, 400);
      case "started":
        return c.json(
          {
            runId: result.runId,
            pipeline: name,
            logs: logsPointer(result.runId),
          },
          201,
        );
    }
  });

  // What this factory fires on its own, with the next occurrence of each and
  // the run it is already waiting on.
  app.get("/api/schedules", async (c) => c.json(await listSchedules(factory)));

  // The same catalog engine as preflight, without a pipeline or a launch. A
  // red report is still a report, so it answers 200.
  app.get("/api/doctor", async (c) =>
    c.json(await runChecks([...doctorChecks(), ...scheduleChecks(factory)])),
  );

  // `jigs sweep` is an HTTP client of this route (ADR 0008). `paths` scopes a
  // clean to the worktrees an operator approved one by one.
  app.post("/api/worktrees/sweep", async (c) => {
    type SweepBody = { clean?: boolean; force?: boolean; paths?: string[] };
    const body = await c.req.json<SweepBody>().catch(() => ({}) as SweepBody);
    return c.json(
      await sweepWorktrees(
        {
          clean: body.clean === true,
          force: body.force === true,
          ...(Array.isArray(body.paths)
            ? { paths: body.paths.filter((p) => typeof p === "string") }
            : {}),
        },
        { sql: registrySql() },
      ),
    );
  });

  // The ingress is stateless (ADR 0009): verify, reconstruct the token, resume.
  // A delivery nobody is listening to is dropped with a 404 — no mapping
  // tables or persisted deliveries. Wakes are hints; consumers re-check the
  // provider.
  app.post("/ingress/github", async (c) => {
    const event = ingressField(c.req.header("x-github-event") ?? "unknown");
    const secret = githubWebhookSecret();
    if (secret === null) {
      console.log(
        `[ingress] github rejected reason=configuration event=${event}`,
      );
      return c.json({ error: "no GitHub webhook secret configured" }, 503);
    }
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!verifyGithubSignature(rawBody, signature, secret)) {
      console.log(`[ingress] github rejected reason=signature event=${event}`);
      return c.json({ error: "invalid signature" }, 401);
    }
    const payload = parseJson(rawBody);
    const token = tokenFromGithubPayload(payload);
    if (token === null) {
      console.log(
        `[ingress] github ignored reason=unrecognized-event event=${event}`,
      );
      return c.json({ ignored: true });
    }
    return deliver(c, "github", token, event, resumeIngressHook);
  });

  app.post("/ingress/linear", async (c) => {
    const secret = process.env.LINEAR_WEBHOOK_SECRET;
    if (secret === undefined || secret === "") {
      console.log("[ingress] linear rejected reason=configuration");
      return c.json({ error: "LINEAR_WEBHOOK_SECRET is not configured" }, 503);
    }
    const rawBody = await c.req.text();
    const signature = c.req.header("linear-signature");
    if (!verifyLinearSignature(rawBody, signature, secret)) {
      console.log("[ingress] linear rejected reason=signature");
      return c.json({ error: "invalid signature" }, 401);
    }
    const payload = parseJson(rawBody);
    if (payload === null) {
      console.log("[ingress] linear ignored reason=unrecognized-shape");
      return c.json({ ignored: true });
    }
    const event = linearEvent(payload);
    const timestamp = (payload as { webhookTimestamp?: unknown })
      .webhookTimestamp;
    if (!linearTimestampFresh(timestamp, Date.now())) {
      console.log(
        `[ingress] linear rejected reason=timestamp${event === null ? "" : ` event=${event}`}`,
      );
      return c.json({ error: "stale webhookTimestamp" }, 401);
    }
    const token = tokenFromLinearPayload(payload);
    if (token === null) {
      console.log(
        `[ingress] linear ignored reason=unrecognized-event${event === null ? "" : ` event=${event}`}`,
      );
      return c.json({ ignored: true });
    }
    return deliver(c, "linear", token, event, resumeIngressHook);
  });

  // Manual wake on the same code path as the ingress: resume every token the
  // run's suspensions are satisfied by. The fallback when a delivery was missed.
  app.post("/api/runs/:runId/poke", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return refError(c, ref);
    const run = getRun(ref.runId);
    const tokens = await runResourceTokens(run.runId);
    if (tokens.length === 0) {
      return c.json({ error: "run has no suspensions to poke" }, 409);
    }
    const poked = await Promise.all(
      tokens.map((token) =>
        resumeHook(token, undefined).then(
          () => ({ token, resumed: true }),
          // A hook disposed between list and resume is a report, not an error.
          () => ({ token, resumed: false }),
        ),
      ),
    );
    return c.json({ runId: run.runId, poked });
  });

  // Everything `jigs ps` renders: the SDK's runs overlaid with jigs' suspended
  // status, plus the worktrees as the sweep classifier sees them — the one
  // deriver of worktree state, so ps and sweep can never disagree.
  app.get("/api/runs", async (c) => {
    const [runs, worktrees] = await Promise.all([
      listRuns(factory),
      sweepWorktrees({ clean: false }, { sql: registrySql() }).then(
        (report) => report.entries,
      ),
    ]);
    // The schedules ride along on the same run listing the table above
    // renders, so ps stays one round trip and the two tables can never
    // disagree about which schedule is busy.
    const schedules = await listSchedules(factory, {
      listRuns: async () => runs,
    });
    return c.json({ runs, worktrees, schedules });
  });

  // The escape hatch for a zombie claim owner. Cancelling releases every hook
  // the run holds — the world deletes them on run_cancelled — so the tokens are
  // captured before the cancel, not after.
  app.post("/api/runs/:runId/cancel", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return refError(c, ref);
    const run = getRun(ref.runId);
    const status = await run.status;
    if (TERMINAL_RUN_STATUSES.has(status)) {
      return c.json(
        { error: `run ${ref.runId} is already ${status}`, status },
        409,
      );
    }
    const releasedTokens = await runResourceTokens(ref.runId);
    await run.cancel();
    // Cancel never cleans up: name what stays so the operator knows where the
    // worktree is and that `jigs sweep` is the way to reclaim it.
    const worktrees = (await listWorktreesForRun(registrySql(), ref.runId)).map(
      (row) => row.path,
    );
    // A merged run's pipeline tears its own worktree down; everything else —
    // cancel included — leaves the tree on disk for the operator's `jigs
    // sweep`. A cancelled run's dirty tree is exactly the wreckage the sweep
    // exists to surface, and reuse already stops naming a cancelled run as an
    // owner.
    return c.json({
      runId: ref.runId,
      cancelled: true,
      releasedTokens,
      worktrees,
    });
  });

  // What the run's own status cannot say: which steps ran, and whether a queue
  // job died holding its resume. Both are what `jigs logs` renders as a
  // timeline, and the second is the only sign of a stall.
  app.get("/api/runs/:runId/steps", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return refError(c, ref);
    const [steps, deadJobs] = await Promise.all([
      listRunSteps(ref.runId),
      listRunDeadJobs(registrySql(), ref.runId),
    ]);
    return c.json({ steps, deadJobs });
  });

  app.get("/api/runs/:runId", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return refError(c, ref);
    const run = getRun(ref.runId);
    const status = await run.status;
    const body: Record<string, unknown> = {
      runId: run.runId,
      status,
      logs: logsPointer(run.runId),
    };
    if (status === "completed") body.returnValue = await run.returnValue;
    if (status === "failed") {
      body.error = await run.returnValue.then(
        () => undefined,
        (err: unknown) => String(err),
      );
    }
    // The SDK has neither `suspended` nor `stalled`, so jigs derives both —
    // through the same function `jigs ps` reads, or the two verbs disagree
    // about the same run.
    if (status === "running") {
      const tokens = await runHookTokens(run.runId);
      const suspensions = tokens.flatMap((token) => {
        const reason = parkReason(token);
        return reason === null ? [] : [{ token, reason }];
      });
      const parked = suspensions.length > 0;
      body.suspensions = suspensions;
      body.suspended = parked;
      body.status = derivedRunStatus(status, {
        parked,
        stalled: !parked && (await stalledRuns()).has(run.runId),
      });
    }
    return c.json(body);
  });

  function unknownPipeline(name: string) {
    return {
      error: `unknown pipeline: ${name}`,
      knownPipelines: Object.keys(factory.pipelines),
    };
  }

  return app;
}

// Liveness must answer from anywhere, including a service started outside a
// factory, so an unlocatable root is reported rather than thrown as a 500.
function factoryRootOrNull(): string | null {
  try {
    return factoryRoot();
  } catch {
    return null;
  }
}

function refError(
  c: Context,
  ref: Exclude<RunRef, { kind: "found" }>,
): Response {
  return ref.kind === "ambiguous"
    ? c.json({ error: "ambiguous run ref", candidates: ref.candidates }, 409)
    : c.json({ error: "not found" }, 404);
}

// The run's page on the dashboard this service hosts. A service started
// without a dashboard port has none to point at, and the answer is not to name
// a standalone `workflow web`: run against a live World it opens a second queue
// worker and steals the jobs this run is waiting on.
function logsPointer(runId: string): string {
  const port = process.env.JIGS_DASHBOARD_PORT;
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

function ingressField(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

function linearEvent(payload: unknown): string | null {
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" ? ingressField(type) : null;
}

// A wake carries no payload: the suspension primitives re-check provider
// state on every wake, so nothing downstream reads one.
async function deliver(
  c: Context,
  provider: "github" | "linear",
  token: string,
  event: string | null,
  resume: typeof resumeHook,
) {
  const correlation = `token=${ingressField(token)}${event === null ? "" : ` event=${event}`}`;
  try {
    const result = await resume(token, undefined);
    console.log(`[ingress] ${provider} accepted ${correlation}`);
    return c.json({ delivered: true, ...result });
  } catch (error) {
    const reason = HookNotFoundError.is(error)
      ? "no-matching-hook"
      : "delivery-failed";
    console.log(
      `[ingress] ${provider} dropped reason=${reason} ${correlation}`,
    );
    return c.json({ delivered: false }, 404);
  }
}

// Both what a run is parked on and why are readings of its hook tokens, so
// the one page of tokens answers both.
async function runHookTokens(runId: string): Promise<string[]> {
  const hooks = await getWorld().hooks.list({ runId });
  return hooks.data.map((hook) => hook.token);
}

// The hooks that name an external resource: what another run can be blocked
// on, and what a poke can wake. The needs-human marker is neither — the reply
// that ends that halt lands on the ticket claim beside it.
async function runResourceTokens(runId: string): Promise<string[]> {
  return (await runHookTokens(runId)).filter(
    (token) => !token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX),
  );
}
