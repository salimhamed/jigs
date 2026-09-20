import { JigsError } from "../../errors.ts";
import { fetchIssueStates, updateIssueState } from "../../providers/linear.ts";

export interface TicketStatusResult {
  from: string;
  to: string;
  changed: boolean;
}

/** Set a ticket to one of its team's named states. */
export async function setTicketStatus(
  issueId: string,
  stateName: string,
): Promise<TicketStatusResult> {
  const issue = await fetchIssueStates(issueId);
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
  await updateIssueState(issueId, target.id);
  return { from: issue.state.name, to: target.name, changed: true };
}
