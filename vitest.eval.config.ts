import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Evals ask the live Jev model through OpenRouter and report accuracy; they never fail on a
// wrong answer. Recipe files import the published package name, so it resolves to source here.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@jigs-ai\/jigs$/, replacement: path.resolve("src/index.ts") }],
  },
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 120_000,
    env: { XDG_DATA_HOME: mkdtempSync(path.join(tmpdir(), "jigs-evals-")) },
  },
});
