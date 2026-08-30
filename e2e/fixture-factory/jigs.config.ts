import type { Factory } from "@jigs/service";
import { fixtureInputs, fixturePipeline } from "./pipelines/fixture.ts";

export default {
  pipelines: {
    fixture: { pipeline: fixturePipeline, inputs: fixtureInputs },
  },
} satisfies Factory;
