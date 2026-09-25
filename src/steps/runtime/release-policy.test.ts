import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { parseFactoryConfig } from "../../config/factory-config.ts";
import { bindReleaseSteps } from "../../workflow/runtime/release.ts";
import {
  effectiveReleasePolicy,
  resolveReleasePolicy,
  workflowReleasePolicy,
} from "./release-policy.ts";

const keep = { onSuccess: "keep", onFailure: "keep" } as const;
const discard = { onSuccess: "release", onFailure: "release" } as const;

test("built-in, factory and workflow policies resolve in order", () => {
  expect(effectiveReleasePolicy()).toEqual({ onSuccess: "release", onFailure: "keep" });
  expect(effectiveReleasePolicy(undefined, keep)).toEqual(keep);
  expect(effectiveReleasePolicy(discard, keep)).toEqual(discard);
  expect(() =>
    parseFactoryConfig({
      service: { dashboardPort: 9000 },
      release: { onSuccess: "oops", onFailure: "keep" },
    }),
  ).toThrow("release.onSuccess");
});

test("two workflows can differ and match compiled IDs rather than config names", () => {
  const workflow = (id: string) => Object.assign(async () => {}, { workflowId: id });
  const factory = {
    workflows: {
      first: { workflow: workflow("workflow//./first//run"), inputs: z.object({}), release: keep },
      second: {
        workflow: workflow("workflow//./second//run"),
        inputs: z.object({}),
        release: discard,
      },
    },
  };
  expect(workflowReleasePolicy(factory, "workflow//./first//run")).toEqual(keep);
  expect(workflowReleasePolicy(factory, "workflow//./second//run")).toEqual(discard);
  expect(workflowReleasePolicy(factory, "missing")).toBeUndefined();
});

test("callsite policy wins and skips the policy read step", async () => {
  const resolveReleasePolicy = vi.fn(async () => discard);
  const releaseRunResources = vi.fn(async () => ({
    policy: keep,
    worktrees: [],
    runDirectory: { path: "scratch", removed: false, reason: "keep" },
  }));
  const { release } = bindReleaseSteps({ resolveReleasePolicy, releaseRunResources });
  await release(keep);
  expect(resolveReleasePolicy).not.toHaveBeenCalled();
  expect(releaseRunResources).toHaveBeenLastCalledWith(keep);
  await release();
  expect(releaseRunResources).toHaveBeenLastCalledWith(discard);
});

test("resolver combines compiled entry and current factory defaults", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-release-policy-"));
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  try {
    writeFileSync(
      path.join(root, "jigs.config.ts"),
      `export default { service: { dashboardPort: 9000 }, release: ${JSON.stringify(keep)} };`,
    );
    const definition = {
      service: { dashboardPort: 9000 },
      workflows: {
        first: async () => ({
          default: {
            workflow: Object.assign(async () => {}, { workflowId: "compiled" }),
            inputs: z.object({}),
            release: discard,
          },
        }),
      },
    };
    expect(
      await resolveReleasePolicy({ workflowRunId: "run_1", workflowName: "compiled" }, definition),
    ).toEqual(discard);
    expect(
      await resolveReleasePolicy({ workflowRunId: "run_1", workflowName: "missing" }, definition),
    ).toEqual(keep);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
afterEach(() => vi.unstubAllEnvs());
