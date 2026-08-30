import { fileURLToPath } from "node:url";
import type { NitroConfig } from "nitro/types";

/** Where `prepare()` writes generated sources, relative to the factory root. */
export const GENERATED_DIR = ".jigs";
export const GENERATED_ENTRY_FILE = "server.ts";

// Nitro resolves a bare `plugins` entry against the build root, which is the
// factory rather than this package, so the path has to be absolute and
// resolved from this module.
const startWorldPlugin = fileURLToPath(
  new URL("../plugins/start-world.ts", import.meta.url),
);

/** The whole Nitro build config for a factory repo, so a factory's own
 *  nitro.config.ts is two lines. */
export function defineJigsService(): NitroConfig {
  // "use workflow"/"use step" directives outside this package only compile if
  // it is consumed as source (AGE-311). Agent steps will need
  // pathToClaudeCodeExecutable pointed at the system `claude` — bundling
  // severs the SDK's vendored CLI.
  return {
    modules: ["workflow/nitro"],
    plugins: [startWorldPlugin],
    // The workflow builder's scan directory stays at its default (the whole
    // root): bounding it to pipelines/ would make a misfiled pipeline
    // silently invisible, which is worse than scanning a little extra.
    routes: { "/**": `./${GENERATED_DIR}/${GENERATED_ENTRY_FILE}` },
  };
}
