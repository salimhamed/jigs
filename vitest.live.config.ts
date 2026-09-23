import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "vitest/config";

const localEnv = ".env.e2e.local";
if (existsSync(localEnv)) loadEnvFile(localEnv);

// Two kinds of live test, one run: the harness tests need a claude.ai login
// and a ChatGPT-authed ~/.codex/auth.json (API keys never reach a harness,
// whose environment jigs builds from empty), and the registry tests need the Postgres on :5439 that
// test/docker-compose.yml brings up (`docker compose -f test/docker-compose.yml
// up -d --wait`) — not a factory's World, a container of their own. Serial on
// purpose: they mutate process.env, share one table, and share subscription
// rate limits.
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
