import { type Context, Hono } from "hono";
import { failedChecks } from "jigs/checks";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { z } from "zod";
import {
  githubWebhookSecret,
  linearTimestampFresh,
  verifyGithubSignature,
  verifyLinearSignature,
  type WakeHint,
} from "./ingress";
import { doctor, preflight } from "./preflight";
import { registry } from "./registry";
import {
  isParkToken,
  listRuns,
  type RunRef,
  resolveRunRef,
  TERMINAL_RUN_STATUSES,
} from "./runs";
import {
  readSuspensionMetadata,
  type SuspensionRecord,
} from "./suspension/record";
import {
  tokenFromGithubPayload,
  tokenFromLinearPayload,
} from "./suspension/tokens";
import {
  connectRegistry,
  listWorktrees,
  type WorktreeRow,
} from "./worktrees/registry";

const app = new Hono();

// Liveness only; dependency verification is preflight's job (ADR 0010).
app.get("/health", (c) =>
  c.json({
    ok: true,
    world: process.env.WORKFLOW_TARGET_WORLD ?? "local (default)",
    pipelines: Object.keys(registry),
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
  const entry = registry[name];
  if (!entry) return c.json(unknownPipeline(name), 404);
  return c.json({
    name,
    inputs: z.toJSONSchema(entry.inputs, {
      io: "input",
      unrepresentable: "any",
    }),
  });
});

app.post("/api/pipelines/:name/runs", async (c) => {
  const name = c.req.param("name");
  const entry = registry[name];
  if (!entry) return c.json(unknownPipeline(name), 404);

  const body = await c.req
    .json<{ inputs?: unknown }>()
    .catch(() => ({}) as { inputs?: unknown });
  // zod-parsed plain JSON is also the serialization guard: unserializable
  // workflow args leave a run stuck `running` forever (workflow@4.8.4).
  const parsed = entry.inputs.safeParse(body.inputs ?? {});
  if (!parsed.success) {
    return c.json(
      { error: "invalid inputs", issues: parsed.error.issues },
      400,
    );
  }

  // Before the run exists (ADR 0010): every failure at once, each carrying
  // its repair, and no run created. There is no skip flag.
  const report = await preflight(entry.requires ?? {});
  if (!report.ok) {
    return c.json(
      { error: "preflight failed", failures: failedChecks(report) },
      424,
    );
  }

  const triggerId = crypto.randomUUID();
  const run = await start(entry.pipeline, [{ ...parsed.data, triggerId }]);
  return c.json(
    {
      runId: run.runId,
      pipeline: name,
      logs: logsPointer(run.runId),
      ...(entry.hookToken ? { resumeToken: entry.hookToken(triggerId) } : {}),
    },
    201,
  );
});

// The same catalog engine as preflight, without a pipeline or a launch. A
// red report is still a report, so it answers 200.
app.get("/api/doctor", async (c) => c.json(await doctor()));

app.post("/api/hooks/resume", async (c) => {
  const { token, payload } = await c.req.json<{
    token: string;
    payload: unknown;
  }>();
  try {
    const result = await resumeHook(token, payload);
    return c.json({ resumed: true, ...result });
  } catch (err) {
    return c.json({ resumed: false, error: String(err) }, 404);
  }
});

// The ingress is stateless (ADR 0009): verify, reconstruct the token, resume.
// A delivery nobody is listening to is dropped with a 404 — no mapping
// tables, no delivery log. Wakes are hints; consumers re-check the provider.
app.post("/ingress/github", async (c) => {
  const secret = githubWebhookSecret();
  if (secret === null) {
    return c.json({ error: "no GitHub webhook secret configured" }, 503);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  if (!verifyGithubSignature(rawBody, signature, secret)) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const payload = parseJson(rawBody);
  const token = tokenFromGithubPayload(payload);
  if (token === null) return c.json({ ignored: true });
  const hint: WakeHint = {
    source: "github",
    event: c.req.header("x-github-event") ?? "unknown",
    ...optionalAction(payload),
  };
  return deliver(c, token, hint);
});

app.post("/ingress/linear", async (c) => {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (secret === undefined || secret === "") {
    return c.json({ error: "LINEAR_WEBHOOK_SECRET is not configured" }, 503);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("linear-signature");
  if (!verifyLinearSignature(rawBody, signature, secret)) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const payload = parseJson(rawBody);
  if (payload === null) return c.json({ ignored: true });
  const timestamp = (payload as { webhookTimestamp?: unknown })
    .webhookTimestamp;
  if (!linearTimestampFresh(timestamp, Date.now())) {
    return c.json({ error: "stale webhookTimestamp" }, 401);
  }
  const token = tokenFromLinearPayload(payload);
  if (token === null) return c.json({ ignored: true });
  const hint: WakeHint = {
    source: "linear",
    type: "Comment",
    ...optionalAction(payload),
  };
  return deliver(c, token, hint);
});

// Manual wake on the same code path as the ingress: resume every token the
// run's suspensions are satisfied by. The fallback when a delivery was missed.
app.post("/api/runs/:runId/poke", async (c) => {
  const ref = await resolveRunRef(c.req.param("runId"));
  if (ref.kind !== "found") return refError(c, ref);
  const run = getRun(ref.runId);
  const { records } = await listSuspensions(run.runId);
  const tokens = [...new Set(records.map((s) => s.satisfiedBy))];
  if (tokens.length === 0) {
    return c.json({ error: "run has no suspensions to poke" }, 409);
  }
  const poked = await Promise.all(
    tokens.map((token) =>
      resumeHook(token, { source: "poke" } satisfies WakeHint).then(
        () => ({ token, resumed: true }),
        // A hook disposed between list and resume is a report, not an error.
        () => ({ token, resumed: false }),
      ),
    ),
  );
  return c.json({ runId: run.runId, poked });
});

// Everything `jigs ps` renders: the SDK's runs overlaid with jigs' suspended
// status, plus the worktree registry's own view of what is on disk.
app.get("/api/runs", async (c) => {
  const [runs, worktrees] = await Promise.all([listRuns(), readWorktrees()]);
  return c.json({ runs, worktrees });
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
  const { records } = await listSuspensions(ref.runId);
  const releasedTokens = [...new Set(records.map((s) => s.satisfiedBy))];
  await run.cancel();
  // AGE-309 applies the teardown matrix to this run's worktrees here.
  return c.json({ runId: ref.runId, cancelled: true, releasedTokens });
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
  // The SDK has no `suspended` status — a parked run reads `running`, so jigs
  // reads parkedness off the hook tokens with the same predicate `jigs ps`
  // uses. A hook carrying no jigs metadata still parks the run; it just has no
  // record to explain itself with, which is why the two answers are separate.
  if (status === "running") {
    const { tokens, records } = await listSuspensions(run.runId);
    body.suspensions = records;
    body.suspended = tokens.some(isParkToken);
  }
  return c.json(body);
});

function unknownPipeline(name: string) {
  return {
    error: `unknown pipeline: ${name}`,
    knownPipelines: Object.keys(registry),
  };
}

function refError(
  c: Context,
  ref: Exclude<RunRef, { kind: "found" }>,
): Response {
  return ref.kind === "ambiguous"
    ? c.json({ error: "ambiguous run ref", candidates: ref.candidates }, 409)
    : c.json({ error: "not found" }, 404);
}

// `workflow web` defaults to the local world, and only the service knows
// which world it actually writes to.
function logsPointer(runId: string): string {
  const world = process.env.WORKFLOW_TARGET_WORLD;
  return world === undefined || world === ""
    ? `npx workflow web ${runId}`
    : `npx workflow web --backend ${world} ${runId}`;
}

// Connect-and-end per request, as the world plugin does: `ps` is
// CLI-frequency, so a pooled connection would cost more concept than latency.
async function readWorktrees(): Promise<WorktreeRow[]> {
  const url = process.env.WORKFLOW_POSTGRES_URL;
  if (url === undefined || url === "") return [];
  const sql = connectRegistry(url);
  try {
    return await listWorktrees(sql);
  } finally {
    await sql.end();
  }
}

// A signed but unparseable body is unroutable, like an unknown event type.
function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function optionalAction(payload: unknown): { action?: string } {
  const action = (payload as { action?: unknown } | null)?.action;
  return typeof action === "string" ? { action } : {};
}

async function deliver(c: Context, token: string, hint: WakeHint) {
  try {
    const result = await resumeHook(token, hint);
    return c.json({ delivered: true, ...result });
  } catch {
    return c.json({ delivered: false }, 404);
  }
}

// Raw tokens alongside the hydrated records: parkedness is a property of the
// token, but only a record can say why, and both come from the one listing.
async function listSuspensions(
  runId: string,
): Promise<{ tokens: string[]; records: SuspensionRecord[] }> {
  const hooks = await getWorld().hooks.list({ runId });
  // The world's list returns metadata still serialized (binary devalue);
  // only getHookByToken hydrates it — hence the per-hook round trip. The
  // rejection handler absorbs a hook disposed between list and get.
  const hydrated = await Promise.all(
    hooks.data.map((hook) =>
      getHookByToken(hook.token).then(
        (full) => readSuspensionMetadata(full.metadata),
        () => null,
      ),
    ),
  );
  return {
    tokens: hooks.data.map((hook) => hook.token),
    records: hydrated.filter(
      (record): record is SuspensionRecord => record !== null,
    ),
  };
}

export default app;
