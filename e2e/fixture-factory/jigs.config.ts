import type { Factory } from "@jigs/service";
import { fixtureInputs, fixturePipeline } from "./pipelines/fixture.ts";

export default {
  pipelines: {
    fixture: { pipeline: fixturePipeline, inputs: fixtureInputs },
  },
  // Never fires — what the build proves is that a schedule compiles and emits
  // no step id of its own.
  schedules: {
    "nightly-fixture": {
      pipeline: "fixture",
      cron: "0 3 * * *",
      inputs: { ticket: "AGE-317" },
    },
  },
} satisfies Factory;
