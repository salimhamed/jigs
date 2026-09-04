import type { Factory } from "@jigs/service";
import { fixtureInputs, fixturePipeline } from "./pipelines/fixture.ts";

export default {
  pipelines: {
    fixture: { pipeline: fixturePipeline, inputs: fixtureInputs },
  },
  // Nothing fires here — this factory's service is never started. What the
  // build proves is that a declared schedule type-checks and compiles, and
  // that it emits no step id of its own.
  schedules: {
    "nightly-fixture": {
      pipeline: "fixture",
      cron: "0 3 * * *",
      inputs: { ticket: "AGE-317" },
    },
  },
} satisfies Factory;
