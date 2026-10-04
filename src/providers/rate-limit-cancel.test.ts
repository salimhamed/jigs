import { afterEach, expect, test, vi } from "vitest";
import { RunCancelledError } from "../run-cancellation.ts";
import { createGithubClient } from "./github-http.ts";

const world = vi.hoisted(() => ({
  status: "running",
  reads: 0,
}));

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_1" }),
}));

vi.mock("workflow/runtime", () => ({
  getWorld: async () => ({
    runs: {
      get: async () => {
        world.reads += 1;
        return { status: world.status };
      },
      waitForTerminalStatus: async (_id: string, { timeoutMs }: { timeoutMs: number }) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 20)));
        return { status: world.status };
      },
    },
  }),
}));

afterEach(() => {
  world.status = "running";
  world.reads = 0;
});

const rateLimited = async () =>
  new Response("{}", { status: 429, headers: { "retry-after": "30" } });

test("a step's GitHub call stops waiting out a rate limit once its run is cancelled", async () => {
  const github = createGithubClient({ fetch: rateLimited });
  const started = Date.now();
  const call = github.send({ auth: { bearer: async () => "t" }, apiPath: "/repos/o/r/pulls/1" });
  setTimeout(() => {
    world.status = "cancelled";
  }, 50);
  await expect(call).rejects.toBeInstanceOf(RunCancelledError);
  await expect(call).rejects.toThrow("so jigs stopped waiting out GitHub's rate limit");
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("a shared mint's wait is not tied to the calling run", async () => {
  const sleep = vi.fn(async () => {});
  const github = createGithubClient({ fetch: rateLimited, sleep });
  world.status = "cancelled";
  await expect(
    github.send({ auth: { bearer: async () => "t" }, apiPath: "/app", signal: null }),
  ).rejects.toThrow("GitHub API 429");
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(world.reads).toBe(0);
});
