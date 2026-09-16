import { type Context, Hono } from "hono";
import { getRun, resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { getWorld } from "workflow/runtime";
import { z } from "zod";
import type { Factory } from "../blocks/factory.ts";
import { tokenFromGithubPayload } from "../blocks/pull-request/gate.ts";
import { tokenFromLinearPayload } from "../blocks/ticket/claim.ts";
import { NEEDS_HUMAN_TOKEN_PREFIX } from "../blocks/ticket/halt-for-human.ts";
import { doctorChecks, failedChecks, runChecks } from "../checks/index.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { findOpenPullRequestsByHeadSha } from "../providers/github.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import { listWorktreesForRun } from "../steps/worktree/registry.ts";
import { registrySql } from "../steps/worktree/sql.ts";
import { sweepWorktrees } from "../steps/worktree/sweep.ts";
import { githubWebhookSecret, verifyGithubSignature, verifyLinearSignature } from "./ingress.ts";
import { deleteRunJobs, listRunDeadJobs, RunJobsLockedError } from "./queue.ts";
import { bootPhase, isReady } from "./readiness.ts";
import { describeRun, enrichSuspensions, listRuns, type RunRef, resolveRunRef } from "./runs.ts";
import { listSchedules, scheduleChecks } from "./schedules.ts";
import { listRunSteps } from "./stalls.ts";
import { startRun } from "./trigger.ts";

// The app is library code: a factory repo installs this package and hands in
// its own workflows, so nothing here may import a workflow module.
export function createApp(factory: Factory): Hono {
  const app = new Hono();

  // Liveness, plus how far the boot has got; dependency verification is
  // preflight's job. Nitro serves this route before the plugins have run, so
  // `ready` — not the 200 — is what `jigs service start` waits on. With a
  // service per factory repo, `factoryRoot` is the only thing that says which
  // factory answers here.
  app.get("/health", (c) =>
    c.json({
      ok: true,
      ready: isReady(),
      phase: bootPhase(),
      world: process.env.WORKFLOW_TARGET_WORLD ?? "local (default)",
      factoryRoot: factoryRootOrNull(),
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

  // The manual half of the trigger path; the schedule ticker fires the same
  // function, so preflight cannot differ between them.
  app.post("/api/workflows/:name/runs", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ inputs?: unknown }>().catch(() => ({}) as { inputs?: unknown });
    const result = await startRun(factory, name, body.inputs, crypto.randomUUID());
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
            logs: logsPointer(result.runId),
          },
          201,
        );
    }
  });

  // What this factory fires on its own, with the next occurrence of each and
  // the run it is already waiting on.
  app.get("/api/schedules", async (c) => c.json(await listSchedules(factory)));

  // The same catalog engine as preflight, without a workflow or a launch. A
  // red report is still a report, so it answers 200.
  app.get("/api/doctor", async (c) =>
    c.json(await runChecks([...doctorChecks(), ...scheduleChecks(factory)])),
  );

  // `jigs sweep` is an HTTP client of this route. `paths` scopes a clean to
  // the worktrees an operator approved one by one.
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

  // The ingress is stateless: verify, reconstruct the token, resume. A
  // delivery nobody is listening to is acknowledged and dropped — no mapping
  // tables or persisted deliveries. Wakes are hints; consumers re-check the
  // provider.
  app.post("/ingress/github", async (c) => {
    const event = sanitizeForLog(c.req.header("x-github-event") ?? "unknown");
    const secret = githubWebhookSecret();
    if (secret === null) {
      console.log(`[ingress] github rejected reason=configuration event=${event}`);
      return c.json({ error: "no GitHub webhook secret configured" }, 503);
    }
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!verifyGithubSignature(rawBody, signature, secret)) {
      console.log(`[ingress] github rejected reason=signature event=${event}`);
      return c.json({ error: "invalid signature" }, 401);
    }
    const payload = parseJson(rawBody);
    if (event === "status") {
      const status = githubStatus(payload);
      if (status === null) {
        console.log(`[ingress] github ignored reason=unrecognized-event event=${event}`);
        return c.json({ ignored: true });
      }
      if (status.state === "pending") {
        console.log(`[ingress] github ignored reason=pending-status event=${event}`);
        return c.json({ ignored: true });
      }
      let prs: Awaited<ReturnType<typeof findOpenPullRequestsByHeadSha>>;
      try {
        prs = await findOpenPullRequestsByHeadSha(status.repository, status.sha);
      } catch (error) {
        const reason =
          error instanceof Error && error.message.includes("GITHUB_TOKEN is not set")
            ? "missing-github-credential"
            : "status-lookup-failed";
        console.log(`[ingress] github dropped reason=${reason} event=${event}`);
        return c.json({ delivered: false }, 404);
      }
      if (prs.length === 0) {
        console.log(`[ingress] github dropped reason=no-open-pull-request event=${event}`);
        return c.json({ delivered: false }, 404);
      }
      const tokens = prs
        .map((pr) =>
          tokenFromGithubPayload({
            pull_request: { number: pr.number },
            repository: { name: pr.repo, owner: { login: pr.owner } },
          }),
        )
        .filter((token): token is string => token !== null);
      return resumeAndLog(c, "github", tokens, event, resumeHook);
    }
    const token = tokenFromGithubPayload(payload);
    if (token === null) {
      console.log(`[ingress] github ignored reason=unrecognized-event event=${event}`);
      return c.json({ ignored: true });
    }
    return resumeAndLog(c, "github", [token], event, resumeHook);
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
    const token = tokenFromLinearPayload(payload);
    if (token === null) {
      console.log(
        `[ingress] linear ignored reason=unrecognized-event${event === null ? "" : ` event=${event}`}`,
      );
      return c.json({ ignored: true });
    }
    return resumeAndLog(c, "linear", [token], event, resumeHook);
  });

  // Manual wake on the same code path as the ingress: resume every token the
  // run's suspensions are satisfied by. The fallback when a delivery was missed.
  app.post("/api/runs/:runId/poke", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return unresolvedRunResponse(c, ref);
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
      sweepWorktrees({ clean: false }, { sql: registrySql() }).then((report) => report.entries),
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
    if (ref.kind !== "found") return unresolvedRunResponse(c, ref);
    const run = getRun(ref.runId);
    const status = await run.status;
    if (TERMINAL_RUN_STATUSES.has(status) && status !== "cancelled") {
      return c.json({ error: `run ${ref.runId} is already ${status}`, status }, 409);
    }
    const releasedTokens = await runResourceTokens(ref.runId);
    if (status !== "cancelled") await run.cancel();
    let deletedJobs: number;
    try {
      deletedJobs = await deleteRunJobs(registrySql(), ref.runId);
    } catch (error) {
      if (error instanceof RunJobsLockedError) {
        return c.json({ error: error.message, retryable: true }, 503);
      }
      throw error;
    }
    // Cancel leaves the worktree behind: name what stays so the operator knows
    // where it is and that `jigs sweep` is the way to reclaim it.
    const worktrees = (await listWorktreesForRun(registrySql(), ref.runId)).map((row) => row.path);
    // A merged run's workflow tears its own worktree down; everything else —
    // cancel included — leaves the tree on disk for the operator's `jigs
    // sweep`. A cancelled run's dirty tree is exactly the wreckage the sweep
    // exists to surface, and reuse already stops naming a cancelled run as an
    // owner.
    return c.json({
      runId: ref.runId,
      cancelled: true,
      deletedJobs,
      releasedTokens,
      worktrees,
    });
  });

  // What the run's own status cannot say: which steps ran, and whether a queue
  // job died holding its resume. Both are what `jigs logs` renders as a
  // timeline, and the second is the only sign of a stall.
  app.get("/api/runs/:runId/steps", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return unresolvedRunResponse(c, ref);
    const [steps, deadJobs] = await Promise.all([
      listRunSteps(ref.runId),
      listRunDeadJobs(registrySql(), ref.runId),
    ]);
    return c.json({ steps, deadJobs });
  });

  // The run described by the one function `jigs ps` reads, or the two verbs
  // answer differently about the same run. One run is worth what the listing
  // will not spend on every run: its steps, terminal or not, and a round trip
  // per halt to read the comment back from Linear.
  app.get("/api/runs/:runId", async (c) => {
    const ref = await resolveRunRef(c.req.param("runId"));
    if (ref.kind !== "found") return unresolvedRunResponse(c, ref);
    const described = await describeRun(ref.runId, { steps: await listRunSteps(ref.runId) });
    const body: Record<string, unknown> = {
      ...described,
      suspensions: await enrichSuspensions(described.suspensions),
      logs: logsPointer(ref.runId),
    };
    // Read only where there is one: a running run's return value is a promise
    // that settles long after this response.
    if (described.status === "completed") {
      body.returnValue = await getRun(ref.runId).returnValue;
    }
    if (described.status === "failed") {
      body.error = await getRun(ref.runId).returnValue.then(
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

// Liveness must answer from anywhere, including a service started outside a
// factory, so an unlocatable root is reported rather than thrown as a 500.
function factoryRootOrNull(): string | null {
  try {
    return factoryRoot();
  } catch {
    return null;
  }
}

function unresolvedRunResponse(c: Context, ref: Exclude<RunRef, { kind: "found" }>): Response {
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

function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

function linearEvent(payload: unknown): string | null {
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" ? sanitizeForLog(type) : null;
}

function githubStatus(payload: unknown): {
  sha: string;
  state: string;
  repository: { owner: string; repo: string };
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as {
    sha?: unknown;
    state?: unknown;
    repository?: { name?: unknown; owner?: { login?: unknown } };
  };
  const { sha, state } = candidate;
  const owner = candidate.repository?.owner?.login;
  const repo = candidate.repository?.name;
  return typeof sha === "string" &&
    typeof state === "string" &&
    typeof owner === "string" &&
    typeof repo === "string"
    ? { sha, state, repository: { owner, repo } }
    : null;
}

// A wake carries no payload: the suspension primitives re-check provider
// state on every wake, so nothing downstream reads one.
async function resumeAndLog(
  c: Context,
  provider: "github" | "linear",
  tokens: string[],
  event: string | null,
  resume: typeof resumeHook,
) {
  const results = await Promise.all(
    tokens.map(async (token) => {
      const correlation = `token=${sanitizeForLog(token)}${event === null ? "" : ` event=${event}`}`;
      try {
        await resume(token, undefined);
        console.log(`[ingress] ${provider} accepted ${correlation}`);
        return "delivered" as const;
      } catch (error) {
        const reason = HookNotFoundError.is(error) ? "no-matching-hook" : "delivery-failed";
        console.log(`[ingress] ${provider} dropped reason=${reason} ${correlation}`);
        return reason;
      }
    }),
  );
  if (results.includes("delivered")) return c.json({ delivered: true });
  return c.json({ delivered: false }, results.includes("delivery-failed") ? 404 : 200);
}

// The hooks that name an external resource: what another run can be blocked
// on, and what a poke can wake. The needs-human marker is neither — the reply
// that ends that halt lands on the ticket claim beside it.
async function runResourceTokens(runId: string): Promise<string[]> {
  const hooks = await getWorld().hooks.list({ runId });
  return hooks.data
    .map((hook) => hook.token)
    .filter((token) => !token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX));
}
