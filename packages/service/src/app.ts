import { Hono } from "hono";
import { getRun, resumeHook, start } from "workflow/api";
import { registry } from "./registry";

const app = new Hono();

// Liveness only, no Postgres roundtrip: dependency verification is
// preflight's job (ADR 0010), and the World monitors its own backend.
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
  // zod-parsed plain JSON doubles as the serialization guard: on
  // workflow@4.8.4 a run whose workflow-level arguments fail serialization
  // never reaches a terminal state — it stays `running` and is re-enqueued
  // on every restart (ADR 0008).
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

app.get("/api/runs/:runId", async (c) => {
  const run = getRun(c.req.param("runId"));
  if (!(await run.exists)) return c.json({ error: "not found" }, 404);
  const status = await run.status;
  const body: Record<string, unknown> = { runId: run.runId, status };
  if (status === "completed") body.returnValue = await run.returnValue;
  return c.json(body);
});

export default app;
