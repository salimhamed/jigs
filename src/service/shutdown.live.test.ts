import { type AddressInfo, createServer } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startOwningSignals } from "./shutdown.ts";

// Its own database, bootstrapped with @workflow/world-postgres's `bootstrap`:
// starting this World creates the workflow schema and graphile's tables, which
// the registry tests' `jigs` database must not acquire.
const url =
  process.env.WORKFLOW_POSTGRES_URL ??
  "postgres://jigs:jigs@localhost:5439/jigs_shutdown_live";

// world-postgres starts graphile's runner inside start() only when it can
// reach the service port within 200ms; a bare listener stands in for the
// service so the runner — and its signal handlers — appear inside the strip.
const service = createServer();
const baseUrlBefore = process.env.WORKFLOW_LOCAL_BASE_URL;
beforeAll(async () => {
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const { port } = service.address() as AddressInfo;
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  if (baseUrlBefore === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
  else process.env.WORKFLOW_LOCAL_BASE_URL = baseUrlBefore;
  await new Promise<void>((resolve) => service.close(() => resolve()));
});

const handlerNames = (signal: NodeJS.Signals) =>
  process.listeners(signal).map((listener) => listener.name);

test("the World's start leaves no graphile signal handler behind, and close() is clean", async () => {
  const world = createWorld({ connectionString: url });
  let duringStart: string[] = [];

  await startOwningSignals(async () => {
    await world.start();
    duringStart = handlerNames("SIGTERM");
  });

  // Without this the strip had nothing to strip and the test proves nothing.
  expect(duringStart).toContain("gracefulHandler");
  expect(handlerNames("SIGTERM")).not.toContain("gracefulHandler");
  expect(handlerNames("SIGINT")).not.toContain("gracefulHandler");

  expect(world.close).toBeDefined();
  await expect(world.close?.()).resolves.toBeUndefined();
});
