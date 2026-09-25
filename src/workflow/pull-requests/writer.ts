import { getWorkflowMetadata } from "workflow";
import { pullRequestScope } from "./marker.ts";

/** The run a marker records as its provenance. */
export function currentRunId(): string {
  return getWorkflowMetadata().workflowRunId;
}

// The compiler stamps a workflow with its durable address —
// `workflow//./workflows/linear-ticket-to-pr/linear-ticket-to-pr//linearTicketToPr` — and only the last segment is a
// name a person wrote. Taking it keeps the scope out of the file layout, so
// moving a workflow file does not orphan the markers on a parked pull request.
// Renaming the function still does, exactly as it moves the durable step ids.
const workflowFunctionName = (workflowName: string): string =>
  workflowName.split("//").at(-1) ?? workflowName;

/**
 * The scope a caller gets when it names none: this workflow's function name
 * and the subject it was given: a ticket key or the pull request itself.
 * Pass an explicit scope to continue another workflow's work, or to review a
 * pull request independently of the run delivering it.
 *
 * @group Pull requests
 */
export function defaultPullRequestScope(subject: string): string {
  return pullRequestScope(workflowFunctionName(getWorkflowMetadata().workflowName), subject);
}
