import { defineConfig } from "vitest/config";

// Live harness tests: require a claude.ai login and a ChatGPT-authed
// ~/.codex/auth.json; the tests strip every API-key env var themselves.
// Serial on purpose — they mutate process.env and share subscription
// rate limits.
export default defineConfig({
  test: {
    include: ["src/**/live/**/*.live.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
