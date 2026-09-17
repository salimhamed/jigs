// The "." export: only what a factory's own code imports by package name —
// the shape it declares its workflows with, the input types its workflow
// bodies name, and the types its step wrappers and tests name. Everything
// else this package does is reached through a subpath, and everything the CLI
// does is reached by relative import.
//
// It must never re-export a *value* from a module that reaches a node builtin,
// reads the environment, or calls the network: this specifier is imported
// workflow-side, where none of the three exists. A type from such a module is
// fine, because a type erases; that is how `ReviewThread` is named below.
// Which subpath a value is reached through does not affect any step id: no
// file here carries a directive, so every id is a factory-local path
// (ADR 0013).

export { JigsError } from "./blocks/errors.ts";
export {
  type AnyWorkflowEntry,
  defineFactory,
  type Factory,
  type FactoryDefinition,
  type GithubDefinition,
  type MergeDefinition,
  type Schedule,
  type TicketWorkflowInputs,
  ticketInput,
  type WorkflowEntry,
  type WorkflowInputs,
} from "./blocks/factory.ts";
export type { WorktreeFacts } from "./blocks/worktree.ts";
// The threads the pull request gate delivers and the builder answers. Named
// here rather than on either subpath because both carry it.
export type { ReviewThread } from "./providers/github.ts";
