/**
 * Define a factory and describe its workflows, schedules, bindings and merge policy.
 *
 * Import this module from factory configuration and workflow code that needs the shared
 * factory types.
 *
 * @packageDocumentation
 */

export { JigsError } from "./blocks/errors.ts";
export {
  type AgentsDefinition,
  type AnyWorkflowEntry,
  defineFactory,
  type Factory,
  type FactoryDefinition,
  type GitHubDefinition,
  type MergeDefinition,
  type Schedule,
  type TicketWorkflowInputs,
  ticketInputSchema,
  type WorkflowEntry,
  type WorkflowInputs,
} from "./blocks/factory.ts";
export type { Worktree } from "./blocks/workspaces/worktree.ts";
// The threads the pull request gate delivers and the builder answers. Named
// here rather than on either subpath because both carry it.
export type { ReviewThread } from "./providers/github.ts";
