import { defineConfig } from "tsdown";

// One entry per exports subpath, emitted under the same name, so the exports
// map and this list are the same shape. `cli` is the exception: it is the bin,
// reached by path rather than by subpath.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/cli.ts",
    "blocks/agents/index": "src/blocks/agents/index.ts",
    "blocks/human/index": "src/blocks/human/index.ts",
    "blocks/linear/index": "src/blocks/linear/index.ts",
    "blocks/pull-requests/index": "src/blocks/pull-requests/index.ts",
    "blocks/workspaces/index": "src/blocks/workspaces/index.ts",
    "blocks/git/index": "src/blocks/git/index.ts",
    "blocks/runtime/index": "src/blocks/runtime/index.ts",
    "steps/agents/index": "src/steps/agents/index.ts",
    "steps/human/index": "src/steps/human/index.ts",
    "steps/linear/index": "src/steps/linear/index.ts",
    "steps/pull-requests/index": "src/steps/pull-requests/index.ts",
    "steps/workspaces/index": "src/steps/workspaces/index.ts",
    "steps/git/index": "src/steps/git/index.ts",
    "steps/runtime/index": "src/steps/runtime/index.ts",
    app: "src/service/app.ts",
    build: "src/service/build.ts",
    nitro: "src/service/nitro.ts",
    schedules: "src/service/schedules.ts",
    // nitro.ts resolves both by file URL rather than by subpath, but the entry
    // has to exist for that path to be there to resolve.
    "plugins/start-dashboard": "src/service/plugins/start-dashboard.ts",
    "plugins/start-world": "src/service/plugins/start-world.ts",
  },
  dts: { tsconfig: "tsconfig.build.json" },
  fixedExtension: false,
});
