import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Live registry tests (real Postgres) run only via `pnpm test:live` — see
// vitest.live.config.ts. The jigs alias points at source so tests don't
// depend on a prior `pnpm build`.
export default defineConfig({
  resolve: {
    alias: {
      jigs: fileURLToPath(new URL("../jigs/src/index.ts", import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
