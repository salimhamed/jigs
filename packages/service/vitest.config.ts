import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Live registry tests (real Postgres) run only via `pnpm test:live` — see
// vitest.live.config.ts. The jigs alias points at source so tests don't
// depend on a prior `pnpm build`.
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
        find: /^jigs\/checks$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/checks/index.ts", import.meta.url),
        ),
      },
      {
        find: /^jigs\/prompts$/,
        replacement: fileURLToPath(
          new URL("../jigs/src/prompts/index.ts", import.meta.url),
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
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
