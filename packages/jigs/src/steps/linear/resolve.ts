import { type LinearIssueRef, linearFor } from "../../providers/linear.ts";

/**
 * Resolve a Linear identifier or issue ID before claiming or reading the ticket.
 *
 * @group Resolve and read
 */
export async function resolveLinearIssue({
  installationName,
  reference,
}: {
  installationName: string;
  reference: string;
}): Promise<LinearIssueRef> {
  return linearFor(installationName).resolveIssueRef(reference);
}
