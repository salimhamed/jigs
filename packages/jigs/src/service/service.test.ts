import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { currentFactoryContext } from "../config/factory-context.ts";
import { inTestFactory } from "../test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import { startTriggers, withdrawInactive } from "./event-triggers/runner.ts";
import { startSchedules } from "./schedules.ts";
import { startService } from "./service.ts";

vi.mock("./boot.ts", () => ({ startWorld: vi.fn(async () => {}) }));
vi.mock("./dashboard.ts", () => ({ startDashboard: vi.fn(async () => {}) }));
vi.mock("./schedules.ts", () => ({ startSchedules: vi.fn() }));
vi.mock("./event-triggers/runner.ts", () => ({
  startTriggers: vi.fn(),
  withdrawInactive: vi.fn(async () => {}),
}));
vi.mock("./automatic-release.ts", () => ({ startAutomaticRelease: vi.fn() }));

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("jigs.factory-context")];
});
inTestFactory({
  hub: { url: "https://hub.example.test" },
});

test("the service runs on the configuration it was built with, whatever jigs.config.ts says now", () => {
  const { root } = currentFactoryContext();
  startService({ workflows: {} } as unknown as Factory, {
    hub: { url: "https://hub.example.test" },
    github: { operator: "built" },
    workflows: {},
  });
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    "export default { hub: { url: 'https://hub.example.test' }, github: { operator: 'edited' }, workflows: {} };\n",
  );

  expect(currentFactoryContext().config.github.operator).toBe("built");
});

test("only active triggers and schedules start; each inactive one is logged, and its waiting occurrences skipped", () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
  const source = { kind: "fake.pages", params: {} };
  const on = { active: true, workflow: "w", source };
  const nightly = { active: true, workflow: "w", cron: "0 3 * * *", inputs: {} };
  startService(
    {
      workflows: {},
      schedules: { nightly, quiet: { ...nightly, active: false } },
      triggers: { pages: on, off: { ...on, active: false } },
    } as unknown as Factory,
    { hub: { url: "https://hub.example.test" }, service: { dashboardPort: 7002 }, workflows: {} },
  );
  expect(vi.mocked(startSchedules).mock.lastCall?.[0].schedules).toEqual({ nightly });
  expect(vi.mocked(startTriggers).mock.lastCall?.[0].triggers).toEqual({ pages: on });
  expect(vi.mocked(withdrawInactive)).toHaveBeenLastCalledWith(["off"]);
  expect(lines).toEqual(["[schedule] quiet inactive", "[trigger] off inactive"]);
});
