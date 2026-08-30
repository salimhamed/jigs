import { defineJigsService } from "@jigs/service/nitro";

// The one line a real factory does not need. Nitro picks the *furthest*
// pnpm-workspace.yaml above the build root as the workspace root, and the
// workflow compiler derives step ids relative to it: left alone, this fixture
// sitting inside the jigs repo would resolve @jigs/service to a path under
// the repo root instead of to a package, and record ids no real factory ever
// emits. A factory repo is its own workspace root, so this restores that.
export default { ...defineJigsService(), workspaceDir: import.meta.dirname };
