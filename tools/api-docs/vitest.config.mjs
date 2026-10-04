import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Output assertions are plain text whatever the developer's shell forces.
    env: { FORCE_COLOR: "0" },
    include: ["*.test.mjs"],
  },
});
