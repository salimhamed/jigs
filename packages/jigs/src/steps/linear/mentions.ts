// Who a ticket run's message in Linear mentions. Every lookup here is best
// effort: a mention decides only who gets notified, so a person Linear cannot
// find is left out with a warning and the message still posts.

import type { LinearClient, LinearProfile } from "../../providers/linear.ts";
import type { TicketParticipants } from "./render.ts";

async function lookup(
  linear: LinearClient,
  email: string,
  role: "operator" | "mention",
): Promise<LinearProfile | null> {
  try {
    const user = await linear.findUserByEmail(email);
    if (user === null) {
      console.warn(`[mentions] no active Linear user has the ${role} email ${email}; skipping`);
    }
    return user;
  } catch (err) {
    console.warn(`[mentions] could not look up the ${role} email ${email}; skipping: ${err}`);
    return null;
  }
}

async function ticketPeople(
  linear: LinearClient,
  issueId: string,
): Promise<{ creator: LinearProfile | null; assignee: LinearProfile | null }> {
  try {
    return await linear.getIssueParticipants(issueId);
  } catch (err) {
    console.warn(
      `[mentions] could not read the creator and assignee of ${issueId}; skipping: ${err}`,
    );
    return { creator: null, assignee: null };
  }
}

function once(users: Array<LinearProfile | null>): LinearProfile[] {
  const seen = new Set<string>();
  return users.filter((user): user is LinearProfile => {
    if (user === null || seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
}

/**
 * Resolve who a message about the issue mentions: the operator, or the creator
 * when there is no operator, then the assignee, then the extra emails, each
 * person once. An operator Linear cannot find leaves the assignee and extras;
 * a ticket whose people cannot be read leaves the rest.
 */
export async function resolveParticipants(
  linear: LinearClient,
  issueId: string,
  who: { operator?: string | undefined; mention?: readonly string[] | undefined },
): Promise<TicketParticipants> {
  const [{ creator, assignee }, operator, ...extra] = await Promise.all([
    ticketPeople(linear, issueId),
    who.operator === undefined ? null : lookup(linear, who.operator, "operator"),
    ...(who.mention ?? []).map((email) => lookup(linear, email, "mention")),
  ]);
  const lead = who.operator === undefined ? creator : operator;
  return {
    creator,
    assignee,
    operator,
    mentions: once([lead, assignee, ...extra]),
  };
}
