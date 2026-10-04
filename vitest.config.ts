import { configDefaults, defineConfig } from "vitest/config";

// Live tests (real agents, real Postgres) run only via `pnpm test:live` — see
// vitest.live.config.ts. Recipes resolve factory imports and run in e2e scaffolds.
export default defineConfig({
  test: {
    // Explicit roots keep agent worktrees under .claude/ out of the run.
    include: ["{src,tools,e2e}/**/*.test.{ts,mjs}"],
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
    // Output assertions are plain text whatever the developer's shell forces.
    env: { FORCE_COLOR: "0" },
  },
});
