/**
 * Configure Nitro to build and host a jigs factory service.
 *
 * @packageDocumentation
 */

import type { NitroConfig } from "nitro/types";
import { GENERATED_DIR, GENERATED_ENTRY_FILE, GENERATED_PLUGIN_FILE } from "./generated-files.ts";

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
    plugins: [`./${GENERATED_DIR}/${GENERATED_PLUGIN_FILE}`],
    // The workflow builder's scan directory stays at its default (the whole
    // root): bounding it to workflows/ would make a misfiled workflow
    // silently invisible, which is worse than scanning a little extra.
    rolldownConfig: { external: [OPTIONAL_TELEMETRY] },
    routes: { "/**": `./${GENERATED_DIR}/${GENERATED_ENTRY_FILE}` },
  };
}
