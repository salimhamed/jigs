import { defineConfig } from "tsdown";

// One entry per exports subpath, emitted under the same name, so the exports
// map and this list are the same shape.
export default defineConfig({
  entry: {
    factory: "src/factory.ts",
    app: "src/app.ts",
    build: "src/build.ts",
    nitro: "src/nitro.ts",
    schedules: "src/schedules.ts",
    "steps/index": "src/steps/index.ts",
    "steps/jit": "src/steps/jit.ts",
    "steps/run": "src/steps/run.ts",
    "suspension/claim": "src/suspension/claim.ts",
    "suspension/needs-human": "src/suspension/needs-human.ts",
    "suspension/pull-request-gate": "src/suspension/pull-request-gate.ts",
    "ticket/review": "src/ticket/review.ts",
    "ticket/snapshot": "src/ticket/snapshot.ts",
    "review-loop/loop": "src/review-loop/loop.ts",
    "review-loop/pull-request": "src/review-loop/pull-request.ts",
    "worktrees/index": "src/worktrees/index.ts",
    "plugins/start-dashboard": "src/plugins/start-dashboard.ts",
    "plugins/start-world": "src/plugins/start-world.ts",
    "providers/linear": "src/providers/linear.ts",
  },
  dts: { tsconfig: "tsconfig.build.json" },
  fixedExtension: false,
});
