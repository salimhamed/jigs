import { defineConfig } from "tsdown";

// One entry per exports subpath, emitted under the same name, so the exports
// map and this list are the same shape. `cli` is the exception: it is the bin,
// reached by path rather than by subpath.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/cli.ts",
    routines: "src/workflow/routines.ts",
    "steps/index": "src/steps/index.ts",
    "steps/agents/index": "src/steps/agents/index.ts",
    "steps/human/index": "src/steps/human/index.ts",
    "steps/linear/index": "src/steps/linear/index.ts",
    "steps/pagerduty/index": "src/steps/pagerduty/index.ts",
    "steps/pull-requests/index": "src/steps/pull-requests/index.ts",
    "steps/slack/index": "src/steps/slack/index.ts",
    "steps/workspaces/index": "src/steps/workspaces/index.ts",
    "steps/git/index": "src/steps/git/index.ts",
    "steps/runtime/index": "src/steps/runtime/index.ts",
    build: "src/service/build.ts",
    nitro: "src/service/nitro.ts",
    service: "src/service/service.ts",
  },
  dts: { tsconfig: "tsconfig.build.json" },
  fixedExtension: false,
});
