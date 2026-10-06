import { JigsError } from "../../errors.ts";
import { linearFor } from "../../providers/linear.ts";

/**
 * The before-and-after state names from a ticket status update.
 *
 * @group Create and update
 */
export interface TicketStatusResult {
  from: string;
  to: string;
  changed: boolean;
}

/**
 * Set a ticket to one of its team's named states.
 *
 * @group Create and update
 */
export async function setTicketStatus({
  installationName,
  issueId,
  stateName,
}: {
  installationName: string;
  issueId: string;
  stateName: string;
}): Promise<TicketStatusResult> {
  const linear = linearFor(installationName);
  const issue = await linear.fetchIssueStates(issueId);
  const target = issue.team.states.nodes.find(
    (state) => state.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (target === undefined) {
    throw new JigsError(
      `Linear team ${issue.team.name} has no state named ${stateName}. Available states: ${issue.team.states.nodes.map((state) => state.name).join(", ")}.`,
    );
  }
  if (issue.state.id === target.id)
    return { from: issue.state.name, to: target.name, changed: false };
  await linear.updateIssueState(issueId, target.id);
  return { from: issue.state.name, to: target.name, changed: true };
}
