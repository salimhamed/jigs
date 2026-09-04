import { fileURLToPath } from "node:url";
import type { NitroConfig } from "nitro/types";

/** Where `prepare()` writes generated sources, relative to the factory root. */
export const GENERATED_DIR = ".jigs";
export const GENERATED_ENTRY_FILE = "server.ts";
export const GENERATED_SCHEDULES_FILE = "schedules.ts";

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
    // The ticker fires the factory's compiled pipelines, which only the
    // factory's own tree can import — hence a generated plugin, resolved
    // against the build root, rather than a second file shipped from here.
    // Nitro invokes plugins in order without awaiting them, so this one is
    // called after the World start rather than after the World is up; the
    // first fire is a whole cron tick away either way.
    plugins: [
      startWorldPlugin,
      `./${GENERATED_DIR}/${GENERATED_SCHEDULES_FILE}`,
    ],
    // The workflow builder's scan directory stays at its default (the whole
    // root): bounding it to pipelines/ would make a misfiled pipeline
    // silently invisible, which is worse than scanning a little extra.
    routes: { "/**": `./${GENERATED_DIR}/${GENERATED_ENTRY_FILE}` },
  };
}
