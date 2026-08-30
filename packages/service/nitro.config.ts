import { defineConfig } from "nitro";

// "use workflow"/"use step" directives outside this package only compile if
// consumed as source (AGE-311). Agent steps will need pathToClaudeCodeExecutable
// pointed at the system `claude` — bundling severs the SDK's vendored CLI.
export default defineConfig({
  modules: ["workflow/nitro"],
  plugins: ["plugins/start-world.ts"],
  routes: { "/**": "./src/server.ts" },
});
