import { type LinearIssueRef, resolveIssueRef } from "../../providers/linear.ts";

/** Resolve a Linear identifier or issue ID before claiming or reading the ticket. */
export async function resolveLinearIssue(reference: string): Promise<LinearIssueRef> {
  return resolveIssueRef(reference);
}
