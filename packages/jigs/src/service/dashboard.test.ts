import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dashboardRunUrl } from "../steps/runtime/run-context.ts";
import { removeTmpDir, useTestFactory } from "../test-fixtures.ts";
import { startDashboard } from "./dashboard.ts";

const startServer = vi.hoisted(() => vi.fn(async () => ({ close: vi.fn() })));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({}) }));
vi.mock("@workflow/web/server", () => ({ startServer }));
vi.mock("./shutdown.ts", () => ({ onShutdown: vi.fn() }));

let parent: string;
beforeEach(() => {
  parent = useTestFactory();
  vi.stubEnv("JIGS_DASHBOARD_PORT", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeTmpDir(parent);
});

test("a dashboard port set only in .env starts the dashboard the run links point at", async () => {
  writeFileSync(path.join(parent, "factory", ".env"), "JIGS_DASHBOARD_PORT=9123\n");
  await startDashboard();
  expect(startServer).toHaveBeenCalledWith(9123);
  expect(dashboardRunUrl("run-1")).toBe("http://localhost:9123/run/run-1");
});
