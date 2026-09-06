import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "harnesses/index": "src/harnesses/index.ts",
    "checks/index": "src/checks/index.ts",
    "prompts/index": "src/prompts/index.ts",
    "steps/index": "src/steps/index.ts",
    "steps/execute": "src/steps/execute.ts",
  },
  dts: true,
  fixedExtension: false,
});
