import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live registry tests: require the service's Postgres (docker, :5439 by
// default). Serial on purpose — they share one table.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^jigs$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^jigs\/steps$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/steps/index.ts", import.meta.url),
        ),
      },
      {
        find: /^jigs\/steps\/execute$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/steps/execute.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["src/**/*.live.test.ts"],
    fileParallelism: false,
  },
});
