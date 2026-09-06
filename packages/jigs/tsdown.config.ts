import { defineConfig } from "tsdown";

// One entry per exports subpath, emitted under the same name, so the exports
// map and this list are the same shape. `cli` is the exception: it is the bin,
// reached by path rather than by subpath.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    app: "src/app.ts",
    build: "src/build.ts",
    "checks/index": "src/checks/index.ts",
    "harnesses/index": "src/harnesses/index.ts",
    nitro: "src/nitro.ts",
    "prompts/index": "src/prompts/index.ts",
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
