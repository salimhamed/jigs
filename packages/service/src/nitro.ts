import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NitroConfig } from "nitro/types";

/** Where `prepare()` writes generated sources, relative to the factory root. */
export const GENERATED_DIR = ".jigs";
export const GENERATED_ENTRY_FILE = "server.ts";
export const GENERATED_SCHEDULES_FILE = "schedules.ts";

// Nitro resolves a bare `plugins` entry against the build root, which is the
// factory rather than this package, so the path has to be absolute and
// resolved from this module. The plugins are emitted beside it with the same
// extension, so one path works for the source under vitest and for dist/.
const extension = path.extname(fileURLToPath(import.meta.url));
const shippedPlugin = (name: string): string =>
  fileURLToPath(new URL(`./plugins/${name}${extension}`, import.meta.url));
const startWorldPlugin = shippedPlugin("start-world");
const startDashboardPlugin = shippedPlugin("start-dashboard");

/** The whole Nitro build config for a factory repo, so a factory's own
 *  nitro.config.ts is two lines. */
export function defineJigsService(): NitroConfig {
  // Agent steps will need pathToClaudeCodeExecutable pointed at the system
  // `claude` — bundling severs the SDK's vendored CLI.
  return {
    modules: ["workflow/nitro"],
    // Nitro invokes plugins in order without awaiting them, so the generated
    // ticker starts after the World start is *called*, not after it finishes
    // — harmless, because the first fire is a whole cron tick away.
    plugins: [
      startWorldPlugin,
      startDashboardPlugin,
      `./${GENERATED_DIR}/${GENERATED_SCHEDULES_FILE}`,
    ],
    // The workflow builder's scan directory stays at its default (the whole
    // root): bounding it to pipelines/ would make a misfiled pipeline
    // silently invisible, which is worse than scanning a little extra.
    routes: { "/**": `./${GENERATED_DIR}/${GENERATED_ENTRY_FILE}` },
  };
}
