import { type Context, Hono } from "hono";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import {
  githubWebhookSecret,
  linearTimestampFresh,
  verifyGithubSignature,
  verifyLinearSignature,
  type WakeHint,
} from "./ingress";
import { registry } from "./registry";
import {
  readSuspensionMetadata,
  type SuspensionRecord,
} from "./suspension/record";
import {
  tokenFromGithubPayload,
  tokenFromLinearPayload,
} from "./suspension/tokens";

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

app.post("/api/pipelines/:name/runs", async (c) => {
  const name = c.req.param("name");
  const entry = registry[name];
  if (!entry) {
    return c.json(
      {
        error: `unknown pipeline: ${name}`,
        knownPipelines: Object.keys(registry),
      },
      404,
    );
  }

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

  const triggerId = crypto.randomUUID();
  const run = await start(entry.pipeline, [{ ...parsed.data, triggerId }]);
  return c.json(
    {
      runId: run.runId,
      pipeline: name,
      ...(entry.hookToken ? { resumeToken: entry.hookToken(triggerId) } : {}),
    },
    201,
  );
});

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
  const timestamp = (payload as { webhookTimestamp?: unknown } | null)
    ?.webhookTimestamp;
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
  const run = getRun(c.req.param("runId"));
  if (!(await run.exists)) return c.json({ error: "not found" }, 404);
  const suspensions = await listSuspensions(run.runId);
  const tokens = [...new Set(suspensions.map((s) => s.satisfiedBy))];
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

app.get("/api/runs/:runId", async (c) => {
  const run = getRun(c.req.param("runId"));
  if (!(await run.exists)) return c.json({ error: "not found" }, 404);
  const status = await run.status;
  const body: Record<string, unknown> = { runId: run.runId, status };
  if (status === "completed") body.returnValue = await run.returnValue;
  if (status === "failed") {
    body.error = await run.returnValue.then(
      () => undefined,
      (err: unknown) => String(err),
    );
  }
  // The SDK has no `suspended` status — a parked run reads `running`, so
  // jigs surfaces what the run is listening on from its hooks' metadata.
  if (status === "running") body.suspensions = await listSuspensions(run.runId);
  return c.json(body);
});

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

async function listSuspensions(runId: string): Promise<SuspensionRecord[]> {
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
  return hydrated.filter(
    (record): record is SuspensionRecord => record !== null,
  );
}

export default app;
