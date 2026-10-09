import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
        },
      },
      {
        // WORKFLOW_POSTGRES_URL, or the container in the repo root's compose.yaml.
        // Each suite creates and drops its own database.
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
