// Who a jigs comment on a Linear ticket mentions. Every lookup here is best
// effort: a mention decides only who gets notified, so a person Linear cannot
// find is left out with a warning and the comment still posts.

import { findUserByEmail, getIssueParticipants, type LinearUser } from "../../providers/linear.ts";
import type { TicketParticipants } from "./render-comment.ts";

async function lookup(email: string, role: "operator" | "mention"): Promise<LinearUser | null> {
  try {
    const user = await findUserByEmail(email);
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
  issueId: string,
): Promise<{ creator: LinearUser | null; assignee: LinearUser | null }> {
  try {
    return await getIssueParticipants(issueId);
  } catch (err) {
    console.warn(
      `[mentions] could not read the creator and assignee of ${issueId}; skipping: ${err}`,
    );
    return { creator: null, assignee: null };
  }
}

function once(users: Array<LinearUser | null>): LinearUser[] {
  const seen = new Set<string>();
  return users.filter((user): user is LinearUser => {
    if (user === null || seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
}

/**
 * Resolve who a comment on the issue mentions: the operator, or the creator
 * when there is no operator, then the assignee, then the extra emails, each
 * person once. An operator Linear cannot find leaves the assignee and extras;
 * a ticket whose people cannot be read leaves the rest.
 */
export async function resolveParticipants(
  issueId: string,
  who: { operator?: string | undefined; mention?: readonly string[] | undefined },
): Promise<TicketParticipants> {
  const [{ creator, assignee }, operator, ...extra] = await Promise.all([
    ticketPeople(issueId),
    who.operator === undefined ? null : lookup(who.operator, "operator"),
    ...(who.mention ?? []).map((email) => lookup(email, "mention")),
  ]);
  const lead = who.operator === undefined ? creator : operator;
  return {
    creator,
    assignee,
    operator,
    mentions: once([lead, assignee, ...extra]),
  };
}
