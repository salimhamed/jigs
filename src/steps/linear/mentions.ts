// Who a jigs comment on a Linear ticket mentions. Every lookup here is best
// effort: a mention decides only who gets notified, so a person Linear cannot
// find is left out with a warning and the comment still posts.

import { readFactoryConfig } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import { findUserByEmail, getIssueParticipants, type LinearUser } from "../../providers/linear.ts";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type { NamedRunMetadata } from "../runtime/run-context.ts";
import { loadRunWorkflow } from "../runtime/run-workflow.ts";
import type { TicketParticipants } from "./render-comment.ts";

/** The operator email this run's comments mention: the workflow's own, else the factory's. */
export async function runOperator(
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
): Promise<string | undefined> {
  const workflow = await loadRunWorkflow(metadata, definition);
  return workflow?.linear?.operator ?? readFactoryConfig(factoryRoot()).linear.operator;
}

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
 * person once. An operator Linear cannot find leaves the assignee and extras.
 */
export async function resolveParticipants(
  issueId: string,
  who: { operator?: string | undefined; mention?: readonly string[] | undefined },
): Promise<TicketParticipants> {
  const { creator, assignee } = await getIssueParticipants(issueId);
  const [operator, ...extra] = await Promise.all([
    who.operator === undefined ? null : lookup(who.operator, "operator"),
    ...(who.mention ?? []).map((email) => lookup(email, "mention")),
  ]);
  const lead = who.operator === undefined ? creator : (operator ?? null);
  return {
    creator,
    assignee,
    operator: operator ?? null,
    mentions: once([lead, assignee, ...extra]),
  };
}
