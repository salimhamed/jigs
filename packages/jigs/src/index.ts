// The "." export: only what a factory's own code imports by package name —
// the shape it declares its pipelines with, the input types its pipeline
// bodies name, and the types its step wrappers and tests name. Everything
// else this package does is reached through a subpath, and everything the CLI
// does is reached by relative import.
//
// It must never re-export a *value* from a module carrying a "use step"/"use
// workflow" directive, a node builtin, or an env read or network call: this
// specifier is imported workflow-side, where the latter two cannot run, and
// routing the workflow surface through one specifier changes the step ids the
// SDK derives from the export subpath. A type from such a module is fine — it
// erases, which is how `ReviewThread` is named below.
export {
  type AnyPipelineEntry,
  type Factory,
  type PipelineEntry,
  type PipelineInputs,
  type Schedule,
  type TicketPipelineInputs,
  ticketInput,
} from "./factory.ts";
// The threads the pull request gate delivers and the builder answers. Named
// here rather than on either subpath because both carry it.
export type { ReviewThread } from "./providers/github.ts";
export type { WorktreeFacts } from "./worktrees/facts.ts";
