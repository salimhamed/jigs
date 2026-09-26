import { beforeEach, expect, test, vi } from "vitest";

const recorded = vi.hoisted(() => vi.fn());
vi.mock("workflow", () => ({ getWorkflowMetadata: () => ({ workflowRunId: "wrun_active" }) }));
vi.mock("./registry.ts", async (original) => ({
  ...(await original<typeof import("./registry.ts")>()),
  currentFactory: () => "factory-a",
  recordResource: recorded,
  registrySql: () => ({}),
}));

const { registerResource } = await import("./resources.ts");

const pr = {
  kind: "pull-request",
  identity: "acme/api#41",
  url: "https://github.com/acme/api/pull/41",
};

beforeEach(() => recorded.mockReset());

test("registration records the resource against the active run and this factory", async () => {
  await expect(registerResource(pr)).resolves.toEqual(pr);
  expect(recorded).toHaveBeenCalledWith({}, { factory: "factory-a", runId: "wrun_active", ...pr });
});

test.each([
  [{ ...pr, kind: "" }, "resource kind must not be empty"],
  [{ ...pr, identity: "" }, "resource identity must not be empty"],
  [{ ...pr, identity: "bad\uD800" }, "resource identity must contain valid Unicode"],
  [{ ...pr, url: "acme/api#41" }, "resource URL is not an absolute URL"],
])("an invalid resource is refused before anything is recorded: %j", async (resource, message) => {
  await expect(registerResource(resource)).rejects.toThrow(message);
  expect(recorded).not.toHaveBeenCalled();
});

test.each(["worktree", "branch", "run-directory", "codex-home", "pi-home"])(
  "the %s kind jigs releases itself is reserved",
  async (kind) => {
    await expect(registerResource({ ...pr, kind })).rejects.toThrow(
      `resource kind ${kind} is reserved`,
    );
    expect(recorded).not.toHaveBeenCalled();
  },
);
