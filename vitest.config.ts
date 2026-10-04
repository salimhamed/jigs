import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { configDefaults, defineConfig } from "vitest/config";

// Values from .env.e2e.local reach the db and live projects only, and shell or
// CI values win over the file.
const localEnv = existsSync(".env.e2e.local")
  ? Object.fromEntries(
      Object.entries(parseEnv(readFileSync(".env.e2e.local", "utf8"))).filter(
        ([name]) => process.env[name] === undefined,
      ),
    )
  : {};

// Serial on purpose: these tests mutate process.env, and the live ones share
// subscription rate limits.
const outside = {
  env: localEnv,
  testTimeout: 600_000,
  hookTimeout: 120_000,
  fileParallelism: false,
};

export default defineConfig({
  test: {
    // Output assertions are plain text whatever the developer's shell forces.
    env: { FORCE_COLOR: "0" },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Explicit roots keep agent worktrees under .claude/ out of the run.
          include: ["{src,tools,e2e}/**/*.test.{ts,mjs}"],
          exclude: [...configDefaults.exclude, "**/*.db.test.ts", "**/*.live.test.ts"],
        },
      },
      {
        // Postgres only: WORKFLOW_POSTGRES_URL, or the container in
        // test/docker-compose.yml. Each suite creates and drops its own databases.
        test: { name: "db", include: ["src/**/*.db.test.ts"], ...outside },
      },
      {
        // Real agents and providers: a claude.ai login, a ChatGPT-authed
        // ~/.codex/auth.json, provider credentials. Each skips without its own.
        test: { name: "live", include: ["src/**/*.live.test.ts"], ...outside },
      },
    ],
  },
});
