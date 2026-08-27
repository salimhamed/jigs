import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "harnesses/index": "src/harnesses/index.ts",
  },
  dts: true,
  fixedExtension: false,
});
