import { defineConfig } from "nitro";

// The workflow module's SWC transform only compiles files this Nitro build
// owns. Directive-bearing code ("use workflow"/"use step") from other
// workspace packages must be consumed as source (tsconfig paths + nitro
// alias onto ../jigs/src) or live in this package — verify transform
// coverage in .output before moving directives out (AGE-311).
//
// Nitro's bundling also severs the Claude Agent SDK from its vendored CLI
// binary: when agent steps arrive, point pathToClaudeCodeExecutable at the
// system `claude` (ADR 0008).
export default defineConfig({
  modules: ["workflow/nitro"],
  plugins: ["plugins/start-world.ts"],
  routes: { "/**": "./src/app.ts" },
});
