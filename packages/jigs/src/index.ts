// The "." export: only what a factory's own code imports by package name —
// the shape it declares its pipelines with, and the two types its step
// wrappers name. Everything else this package does is reached through a
// subpath, and everything the CLI does is reached by relative import.
//
// It must never re-export a module carrying a "use step"/"use workflow"
// directive or a node builtin: this specifier is imported workflow-side, and
// routing the workflow surface through one specifier changes the step ids the
// SDK derives from the export subpath.
export {
  type AnyPipelineEntry,
  type Factory,
  type PipelineEntry,
  type Schedule,
  ticketInput,
} from "./factory.ts";
export type { WorktreeFacts } from "./worktrees/facts.ts";
