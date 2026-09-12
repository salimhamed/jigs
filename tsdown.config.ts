import { defineConfig } from "tsdown";

// One entry per exports subpath, emitted under the same name, so the exports
// map and this list are the same shape. `cli` is the exception: it is the bin,
// reached by path rather than by subpath.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/cli.ts",
    "blocks/index": "src/blocks/index.ts",
    "steps/index": "src/steps/index.ts",
    "blocks/agent/index": "src/blocks/agent/index.ts",
    "blocks/ticket/index": "src/blocks/ticket/index.ts",
    "blocks/pull-request/index": "src/blocks/pull-request/index.ts",
    "blocks/delivery/index": "src/blocks/delivery/index.ts",
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
