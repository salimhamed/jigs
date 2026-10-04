import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { currentFactoryContext } from "../config/factory-context.ts";
import { inTestFactory } from "../test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import { startService } from "./service.ts";

vi.mock("./boot.ts", () => ({ startWorld: vi.fn(async () => {}) }));
vi.mock("./dashboard.ts", () => ({ startDashboard: vi.fn(async () => {}) }));
vi.mock("./schedules.ts", () => ({ startSchedules: vi.fn() }));
vi.mock("./event-triggers/runner.ts", () => ({ startTriggers: vi.fn() }));
vi.mock("./automatic-release.ts", () => ({ startAutomaticRelease: vi.fn() }));

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("jigs.factory-context")];
});
inTestFactory({ service: { port: 8990, dashboardPort: 9090 } });

test("the service runs on the configuration it was built with, whatever jigs.config.ts says now", () => {
  const { root } = currentFactoryContext();
  startService({ workflows: {} } as unknown as Factory, {
    service: { port: 7001, dashboardPort: 7002 },
    workflows: {},
  });
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    "export default { service: { port: 8001, dashboardPort: 8002 }, workflows: {} };\n",
  );

  expect(currentFactoryContext().config.service.port).toBe(7001);
});
