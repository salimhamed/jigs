import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live registry tests: they need a real Postgres on :5439, which is what
// test/docker-compose.yml brings up (`docker compose -f test/docker-compose.yml
// up -d --wait`). Not a factory's World — this container belongs to these
// tests. Serial on purpose: they share one table.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@salimhamed\/jigs$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@salimhamed\/jigs\/checks$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/checks/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@salimhamed\/jigs\/prompts$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/prompts/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@salimhamed\/jigs\/steps$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/steps/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@salimhamed\/jigs\/steps\/execute$/,
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
