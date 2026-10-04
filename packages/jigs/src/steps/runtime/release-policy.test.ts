import { expect, test } from "vitest";
import { z } from "zod";
import { parseFactoryConfig } from "../../workflow/factory-schema.ts";
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
      hub: { url: "https://hub.example.test" },
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

test("resolver combines compiled entry and the factory's own default", async () => {
  const definition = {
    hub: { url: "https://hub.example.test" },
    service: { dashboardPort: 9000 },
    release: keep,
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
});
