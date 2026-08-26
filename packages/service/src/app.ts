import { Hono } from "hono";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { registry } from "./registry";
import {
  readSuspensionMetadata,
  type SuspensionRecord,
} from "./suspension/record";

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

async function listSuspensions(runId: string): Promise<SuspensionRecord[]> {
  const { getWorld } = await import("workflow/runtime");
  const hooks = await getWorld().hooks.list({ runId });
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
