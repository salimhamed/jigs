/**
 * Configure Nitro to build and host a jigs factory service.
 *
 * @packageDocumentation
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NitroConfig } from "nitro/types";
import {
  GENERATED_CLEANUP_FILE,
  GENERATED_DIR,
  GENERATED_ENTRY_FILE,
  GENERATED_SCHEDULES_FILE,
} from "./build.ts";

// Nitro resolves a bare `plugins` entry against the build root, which is the
// factory rather than this package, so the path has to be absolute and
// resolved from this module. The plugins are emitted beside it with the same
// extension, so one path works for the source under vitest and for dist/.
const extension = path.extname(fileURLToPath(import.meta.url));
const shippedPlugin = (name: string): string =>
  fileURLToPath(new URL(`./plugins/${name}${extension}`, import.meta.url));
const startWorldPlugin = shippedPlugin("start-world");
const startDashboardPlugin = shippedPlugin("start-dashboard");

// Both Worlds the SDK can load reach for `@opentelemetry/api` behind a
// `.catch(() => null)` — telemetry is optional and no factory installs it —
// so rolldown cannot resolve it and prints a boxed warning per World on every
// green build. Declared external it stays the runtime import the catch
// already handles. Named rather than filtered: a filter over the diagnostic
// would swallow the unresolved imports that are real.
const OPTIONAL_TELEMETRY = "@opentelemetry/api";

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
      `./${GENERATED_DIR}/${GENERATED_CLEANUP_FILE}`,
    ],
    // The workflow builder's scan directory stays at its default (the whole
    // root): bounding it to workflows/ would make a misfiled workflow
    // silently invisible, which is worse than scanning a little extra.
    rolldownConfig: { external: [OPTIONAL_TELEMETRY] },
    routes: { "/**": `./${GENERATED_DIR}/${GENERATED_ENTRY_FILE}` },
  };
}
