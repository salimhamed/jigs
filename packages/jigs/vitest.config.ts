import { configDefaults, defineConfig } from "vitest/config";

// Live harness tests (real subscriptions, real agents) run only via
// `pnpm test:live` — see vitest.live.config.ts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
