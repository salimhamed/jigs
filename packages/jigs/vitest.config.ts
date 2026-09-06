import { configDefaults, defineConfig } from "vitest/config";

// Live tests (real agents, real Postgres) run only via `pnpm test:live` — see
// vitest.live.config.ts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
