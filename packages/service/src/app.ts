import { Hono } from "hono";
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

export default app;
