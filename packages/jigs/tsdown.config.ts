import { defineConfig } from "tsdown";

// One entry per exports subpath, emitted under the same name, so the exports
// map and this list are the same shape. `cli` is the exception: it is the bin,
// reached by path rather than by subpath.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/cli.ts",
    app: "src/service/app.ts",
    build: "src/service/build.ts",
    "checks/index": "src/checks/index.ts",
    "harnesses/index": "src/steps/agent/harnesses/index.ts",
    nitro: "src/service/nitro.ts",
    "prompts/index": "src/compat/prompts.ts",
    schedules: "src/service/schedules.ts",
    "steps/index": "src/compat/steps.ts",
    "steps/jit": "src/blocks/agent/agent-or-halt.ts",
    "steps/run": "src/compat/steps-run.ts",
    "suspension/claim": "src/blocks/ticket/claim.ts",
    "suspension/needs-human": "src/compat/suspension-needs-human.ts",
    "suspension/pull-request-gate":
      "src/compat/suspension-pull-request-gate.ts",
    "ticket/review": "src/blocks/ticket/review.ts",
    "ticket/snapshot": "src/compat/ticket-snapshot.ts",
    "review-loop/index": "src/compat/review-loop.ts",
    "review-loop/pull-request": "src/compat/review-loop-pull-request.ts",
    "worktrees/index": "src/steps/worktree/index.ts",
    "plugins/start-dashboard": "src/service/plugins/start-dashboard.ts",
    "plugins/start-world": "src/service/plugins/start-world.ts",
    "providers/linear": "src/providers/linear.ts",
  },
  dts: { tsconfig: "tsconfig.build.json" },
  fixedExtension: false,
});
